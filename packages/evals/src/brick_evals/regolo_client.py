"""Regolo OpenAI-compatible client per generazione synthetic + LLM-as-judge.

Modello: qwen3.5-122b (fuori-pool rispetto a {qwen3.5-9b, deepseek-v4-flash, kimi2.6}).
"""

from __future__ import annotations

import time

import requests

from .io_utils import regolo_synthetic_key

DEFAULT_BASE_URL = "https://api.regolo.ai/v1"
DEFAULT_MODEL = "qwen3.5-122b"


class RegoloClient:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        model: str = DEFAULT_MODEL,
        timeout: int = 120,
        max_retries: int = 3,
    ):
        self.api_key = api_key or regolo_synthetic_key()
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout
        self.max_retries = max_retries

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def chat(
        self,
        messages: list[dict],
        *,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        top_p: float = 1.0,
        stream: bool = False,
        model: str | None = None,
        thinking_disabled: bool = True,
        extra_body: dict | None = None,
    ) -> dict:
        url = f"{self.base_url}/chat/completions"
        body = {
            "model": model or self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "top_p": top_p,
            "stream": stream,
        }
        if thinking_disabled:
            body["chat_template_kwargs"] = {"enable_thinking": False}
        if extra_body:
            body.update(extra_body)
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                r = requests.post(url, headers=self._headers(), json=body, timeout=self.timeout)
                if r.status_code == 429:
                    time.sleep(2**attempt)
                    continue
                r.raise_for_status()
                return r.json()
            except requests.RequestException as e:
                last_err = e
                if attempt < self.max_retries - 1:
                    time.sleep(2**attempt)
                else:
                    raise
        if last_err:
            raise last_err
        raise RuntimeError("unreachable")

    def text(
        self,
        prompt: str,
        *,
        system: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        thinking_disabled: bool = True,
    ) -> str:
        msgs = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs.append({"role": "user", "content": prompt})
        resp = self.chat(msgs, temperature=temperature, max_tokens=max_tokens, thinking_disabled=thinking_disabled)
        msg = resp["choices"][0]["message"]
        # Fallback: se content e' null/empty, usa reasoning_content (thinking-mode response)
        return (msg.get("content") or msg.get("reasoning_content") or "").strip()

    def list_models(self) -> list[dict]:
        r = requests.get(f"{self.base_url}/models", headers=self._headers(), timeout=30)
        r.raise_for_status()
        return r.json().get("data", [])
