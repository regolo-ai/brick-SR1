"""Async OpenRouter client per inferenza Dataset A.

- Chat completions endpoint OpenAI-compatible
- Retry esponenziale su 429 / 5xx con jitter
- Estrae `message.content` + `message.reasoning` (thinking)
- Cattura `usage` incluso `cost` (richiede `usage.include=true` nel body)
- Concurrency-safe: una sola istanza condivide AsyncClient pool

Docs: https://openrouter.ai/docs/api-reference/chat-completion
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .io_utils import openrouter_key

DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
DEFAULT_TIMEOUT = 1200.0  # 20 min: math/coding con thinking lungo
DEFAULT_MAX_RETRIES = 4


@dataclass
class InferenceResult:
    """Output normalizzato di una singola call."""

    content: str
    reasoning: str | None
    finish_reason: str | None
    prompt_tokens: int
    completion_tokens: int
    reasoning_tokens: int
    total_tokens: int
    cost: float | None
    latency_ms: int
    attempt: int
    raw_response: dict = field(default_factory=dict)
    error: str | None = None


class OpenRouterError(Exception):
    pass


class OpenRouterClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        http_referer: str = "https://github.com/regolo-ai/brick-SR1",
        x_title: str = "Dataset A routing eval",
    ):
        self.api_key = api_key or openrouter_key()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.max_retries = max_retries
        self._headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": http_referer,
            "X-Title": x_title,
        }
        self._client: httpx.AsyncClient | None = None

    async def __aenter__(self) -> OpenRouterClient:
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(self.timeout, connect=30.0),
            limits=httpx.Limits(max_connections=64, max_keepalive_connections=32),
            headers=self._headers,
        )
        return self

    async def __aexit__(self, *exc) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def chat(
        self,
        *,
        model: str,
        messages: list[dict],
        temperature: float = 0.0,
        max_tokens: int = 4096,
        top_p: float = 1.0,
        reasoning: bool = True,
        extra_body: dict | None = None,
    ) -> InferenceResult:
        """Single chat completion. Restituisce InferenceResult normalizzato."""
        if self._client is None:
            raise RuntimeError("OpenRouterClient must be used as async context manager")

        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "top_p": top_p,
            "usage": {"include": True},
        }
        if reasoning:
            body["reasoning"] = {"enabled": True}
        if extra_body:
            body.update(extra_body)

        url = f"{self.base_url}/chat/completions"
        last_err: str | None = None
        attempt = 0
        t0 = time.perf_counter()

        for attempt in range(1, self.max_retries + 1):
            try:
                r = await self._client.post(url, json=body)
            except (httpx.TimeoutException, httpx.TransportError) as e:
                last_err = f"{type(e).__name__}: {e}"
                await self._backoff(attempt)
                continue

            if r.status_code == 429 or r.status_code >= 500:
                last_err = f"HTTP {r.status_code}: {r.text[:200]}"
                await self._backoff(attempt, retry_after=r.headers.get("retry-after"))
                continue

            if r.status_code >= 400:
                latency_ms = int((time.perf_counter() - t0) * 1000)
                return InferenceResult(
                    content="",
                    reasoning=None,
                    finish_reason=None,
                    prompt_tokens=0,
                    completion_tokens=0,
                    reasoning_tokens=0,
                    total_tokens=0,
                    cost=None,
                    latency_ms=latency_ms,
                    attempt=attempt,
                    raw_response={},
                    error=f"HTTP {r.status_code}: {r.text[:500]}",
                )

            try:
                data = r.json()
            except (ValueError, json.JSONDecodeError) as e:
                last_err = f"JSONDecodeError: {str(e)[:120]} | body[:300]: {r.text[:300]}"
                await self._backoff(attempt)
                continue
            return self._parse_response(data, attempt=attempt, started_at=t0)

        latency_ms = int((time.perf_counter() - t0) * 1000)
        return InferenceResult(
            content="",
            reasoning=None,
            finish_reason=None,
            prompt_tokens=0,
            completion_tokens=0,
            reasoning_tokens=0,
            total_tokens=0,
            cost=None,
            latency_ms=latency_ms,
            attempt=attempt,
            raw_response={},
            error=f"max_retries exceeded: {last_err}",
        )

    @staticmethod
    async def _backoff(attempt: int, retry_after: str | None = None) -> None:
        if retry_after:
            try:
                await asyncio.sleep(min(float(retry_after), 60.0))
                return
            except ValueError:
                pass
        delay = min(2**attempt + random.uniform(0, 1), 30.0)
        await asyncio.sleep(delay)

    @staticmethod
    def _parse_response(data: dict, *, attempt: int, started_at: float) -> InferenceResult:
        latency_ms = int((time.perf_counter() - started_at) * 1000)
        if not data.get("choices"):
            return InferenceResult(
                content="",
                reasoning=None,
                finish_reason=None,
                prompt_tokens=0,
                completion_tokens=0,
                reasoning_tokens=0,
                total_tokens=0,
                cost=None,
                latency_ms=latency_ms,
                attempt=attempt,
                raw_response=data,
                error=f"no choices in response: {str(data)[:300]}",
            )

        choice = data["choices"][0]
        msg = choice.get("message") or {}
        content = (msg.get("content") or "").strip()
        # OpenRouter espone reasoning in `message.reasoning` (string)
        reasoning = msg.get("reasoning")
        if isinstance(reasoning, str):
            reasoning = reasoning.strip() or None
        elif reasoning is None and msg.get("reasoning_content"):
            reasoning = (msg.get("reasoning_content") or "").strip() or None

        finish_reason = choice.get("finish_reason") or choice.get("native_finish_reason")

        usage = data.get("usage") or {}
        prompt_tokens = int(usage.get("prompt_tokens") or 0)
        completion_tokens = int(usage.get("completion_tokens") or 0)
        total_tokens = int(usage.get("total_tokens") or 0)
        # OpenRouter usage.completion_tokens_details.reasoning_tokens
        reasoning_tokens = 0
        if details := usage.get("completion_tokens_details"):
            reasoning_tokens = int(details.get("reasoning_tokens") or 0)
        cost = usage.get("cost")
        if cost is not None:
            try:
                cost = float(cost)
            except (TypeError, ValueError):
                cost = None

        return InferenceResult(
            content=content,
            reasoning=reasoning,
            finish_reason=finish_reason,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            reasoning_tokens=reasoning_tokens,
            total_tokens=total_tokens,
            cost=cost,
            latency_ms=latency_ms,
            attempt=attempt,
            raw_response=data,
            error=None if content or reasoning else "empty content+reasoning",
        )
