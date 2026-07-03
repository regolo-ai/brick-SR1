"""Async OpenRouter client per LLM-as-judge grading.

Pattern simile a `regolo_client.py` (sync) ma async via httpx.AsyncClient per
`asyncio.gather` concurrent in `110_grade_inference.py`.

Default model: openai/gpt-5.4-mini ($0.75/$4.50 per M token, 400K ctx).
Auth: OPENROUTER_API_KEY o OPENROUTER_KEY env var.
"""

from __future__ import annotations

import asyncio
import os

import httpx

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_MODEL = "openai/gpt-5.4-mini"
DEFAULT_TIMEOUT = 120.0


def _load_key() -> str:
    k = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("OPENROUTER_KEY")
    if not k:
        from pathlib import Path

        env_path = Path(__file__).resolve().parents[2] / ".env"
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if "=" in line and not line.startswith("#"):
                    kk, vv = line.split("=", 1)
                    if kk.strip() in ("OPENROUTER_API_KEY", "OPENROUTER_KEY"):
                        return vv.strip().strip('"').strip("'")
    if not k:
        raise RuntimeError("OPENROUTER_API_KEY / OPENROUTER_KEY non trovato")
    return k


class OpenRouterJudgeClient:
    """Async OpenAI-compatible client per OpenRouter.

    Usage:
        async with OpenRouterJudgeClient() as client:
            resp = await client.chat([{"role": "user", "content": "..."}])
    """

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = 5,
    ):
        self.api_key = api_key or _load_key()
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.max_retries = max_retries
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self):
        self._client = httpx.AsyncClient(timeout=self.timeout)
        return self

    async def __aexit__(self, *args):
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/regolo-ai/brick-SR1",
            "X-Title": "brick-judge",
        }

    async def chat(
        self,
        messages: list[dict],
        *,
        temperature: float = 0.0,
        max_tokens: int = 512,
        top_p: float = 1.0,
        model: str | None = None,
    ) -> dict:
        """Chat completion. Retry su 429/5xx con backoff esponenziale.

        Returns OpenAI-format dict: {"choices": [{"message": {"content": "..."}}], "usage": {...}}
        """
        if self._client is None:
            raise RuntimeError("client non in context: usa 'async with OpenRouterJudgeClient() as c'")
        body = {
            "model": model or self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "top_p": top_p,
        }
        url = f"{self.base_url}/chat/completions"
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                r = await self._client.post(url, headers=self._headers(), json=body)
                if r.status_code == 429 or r.status_code >= 500:
                    # backoff: 1, 2, 4, 8, 16s
                    await asyncio.sleep(2**attempt)
                    last_err = httpx.HTTPStatusError(
                        f"status {r.status_code}: {r.text[:200]}", request=r.request, response=r
                    )
                    continue
                r.raise_for_status()
                return r.json()
            except httpx.HTTPStatusError as e:
                last_err = e
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(2**attempt)
                else:
                    raise
            except (httpx.TimeoutException, httpx.NetworkError) as e:
                last_err = e
                if attempt < self.max_retries - 1:
                    await asyncio.sleep(2**attempt)
                else:
                    raise
        if last_err:
            raise last_err
        raise RuntimeError("unreachable")
