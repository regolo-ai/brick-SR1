#!/usr/bin/env python3
"""
Brick Complexity Extractor Server

Loads regolo/brick-complexity-2-eco (LoRA on Qwen3.5-0.8B) for query complexity
classification into easy/medium/hard.

Endpoints:
  POST /classify              {"text": "..."} → {"label": "hard", "confidence": 0.9412}
  POST /v1/chat/completions   OpenAI-compatible; returns the label as the
                              completion and the easy/medium/hard token
                              logprobs so a router can recover confidence.
  GET  /v1/models             OpenAI-compatible model list.
  GET  /health                → {"status": "ok", "model": "regolo/brick-complexity-2-eco"}

Usage:
  python server.py --port 8093
  python server.py --port 8093 --device cpu
  python server.py --port 8093 --device cuda
"""

import argparse
import hmac
import logging
import os
import time
import uuid

import torch
import torch.nn.functional as F
from aiohttp import web
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

DEFAULT_MODEL_ID = "regolo/brick-complexity-2-eco"
DEFAULT_BASE_MODEL_ID = "Qwen/Qwen3.5-0.8B"

LABELS = ["easy", "medium", "hard"]

SYSTEM_PROMPT = (
    "You are a query complexity classifier for an LLM routing system. "
    "Classify the following query into exactly one category:\n"
    "- easy: Simple factual recall, 1-2 reasoning steps, basic knowledge\n"
    "- medium: Moderate analysis, 3-5 reasoning steps, domain familiarity needed\n"
    "- hard: Complex multi-step reasoning, expert knowledge, synthesis across domains\n\n"
    "Respond with only the label: easy, medium, or hard."
)


class BrickComplexityServer:
    def __init__(self, model_id=DEFAULT_MODEL_ID, base_model_id=DEFAULT_BASE_MODEL_ID, device="auto"):
        self.model_id = model_id
        self.base_model_id = base_model_id

        if device == "auto":
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        else:
            self.device = torch.device(device)

        dtype = torch.bfloat16 if self.device.type == "cuda" else torch.float32

        logger.info(f"Loading base model {self.base_model_id} on {self.device} ({dtype})...")
        start = time.time()

        self.tokenizer = AutoTokenizer.from_pretrained(
            self.base_model_id, trust_remote_code=True
        )

        base_model = AutoModelForCausalLM.from_pretrained(
            self.base_model_id,
            torch_dtype=dtype,
            trust_remote_code=True,
        )

        logger.info(f"Loading LoRA adapter {self.model_id}...")
        self.model = PeftModel.from_pretrained(base_model, self.model_id)
        self.model.to(self.device)
        self.model.eval()

        # Pre-compute token IDs for label extraction
        self.label_ids = {
            label: self.tokenizer.encode(label, add_special_tokens=False)[0]
            for label in LABELS
        }

        elapsed = time.time() - start
        logger.info(
            f"Model loaded in {elapsed:.1f}s on {self.device} "
            f"(label_ids: {self.label_ids})"
        )

    def _label_scores(self, text: str):
        """Run one forward pass and return (probs, logprobs) over LABELS as
        plain Python lists. Shared by /classify and /v1/chat/completions so both
        protocols are numerically identical."""
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"Classify: {text}"},
        ]

        prompt = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True
        )
        inputs = self.tokenizer(
            prompt, return_tensors="pt", add_special_tokens=False
        ).to(self.device)

        with torch.no_grad():
            logits = self.model(**inputs).logits[0, -1, :]

        label_logits = torch.tensor(
            [logits[self.label_ids[l]].float() for l in LABELS]
        )
        logprobs = F.log_softmax(label_logits, dim=0)
        probs = logprobs.exp()
        return probs.tolist(), logprobs.tolist()

    def classify(self, text: str) -> dict:
        probs, _ = self._label_scores(text)
        best_idx = max(range(len(LABELS)), key=lambda i: probs[i])
        return {"label": LABELS[best_idx], "confidence": round(probs[best_idx], 4)}

    def classify_openai(self, text: str):
        """Return (label, confidence, logprobs) where logprobs maps each label
        to its natural-log probability (OpenAI logprob convention)."""
        probs, logprobs = self._label_scores(text)
        best_idx = max(range(len(LABELS)), key=lambda i: probs[i])
        lp = {LABELS[i]: logprobs[i] for i in range(len(LABELS))}
        return LABELS[best_idx], round(probs[best_idx], 4), lp


server_instance: BrickComplexityServer | None = None
expected_token: str = ""


@web.middleware
async def auth_middleware(request, handler):
    # /health and /v1/models stay open for probes; the inference endpoints
    # (/classify and /v1/chat/completions) require the bearer token when set.
    protected = request.path in ("/classify", "/v1/chat/completions")
    if expected_token and protected:
        header = request.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix) or not hmac.compare_digest(
            header[len(prefix):], expected_token
        ):
            return web.json_response({"error": "unauthorized"}, status=401)
    return await handler(request)


def _extract_query(messages) -> str:
    """Pull the query text from OpenAI chat messages: last user message, with an
    optional leading 'Classify: ' stripped (the brick router adds that prefix;
    classify() re-applies the full template internally)."""
    text = ""
    for m in messages or []:
        if isinstance(m, dict) and m.get("role") == "user":
            text = m.get("content", "") or ""
    if isinstance(text, list):  # content parts form
        text = " ".join(
            p.get("text", "") for p in text if isinstance(p, dict)
        )
    text = text.strip()
    if text.lower().startswith("classify:"):
        text = text[len("classify:"):].strip()
    return text


async def handle_openai_chat(request):
    try:
        data = await request.json()
        text = _extract_query(data.get("messages", []))
        if not text:
            return web.json_response({"error": "No user message provided"}, status=400)

        start = time.time()
        label, confidence, logprobs = server_instance.classify_openai(text)
        elapsed_ms = (time.time() - start) * 1000
        logger.info(
            f"Classified (openai) in {elapsed_ms:.1f}ms: "
            f"label={label}, confidence={confidence}"
        )

        top_logprobs = [
            {"token": l, "logprob": logprobs[l], "bytes": list(l.encode())}
            for l in LABELS
        ]
        resp = {
            "id": f"chatcmpl-{uuid.uuid4().hex}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": data.get("model") or (server_instance.model_id if server_instance else DEFAULT_MODEL_ID),
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": label},
                    "logprobs": {
                        "content": [
                            {
                                "token": label,
                                "logprob": logprobs[label],
                                "bytes": list(label.encode()),
                                "top_logprobs": top_logprobs,
                            }
                        ]
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 0, "completion_tokens": 1, "total_tokens": 1},
        }
        return web.json_response(resp)
    except Exception as e:
        logger.error(f"OpenAI classification error: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


async def handle_models(request):
    model_id = server_instance.model_id if server_instance else DEFAULT_MODEL_ID
    return web.json_response(
        {
            "object": "list",
            "data": [
                {"id": model_id, "object": "model", "owned_by": "brick"},
                {"id": "brick-complexity", "object": "model", "owned_by": "brick"},
            ],
        }
    )


async def handle_classify(request):
    try:
        data = await request.json()
        text = data.get("text", "")
        if not text:
            return web.json_response({"error": "No text provided"}, status=400)

        start = time.time()
        result = server_instance.classify(text)
        elapsed_ms = (time.time() - start) * 1000

        logger.info(
            f"Classified in {elapsed_ms:.1f}ms: "
            f"label={result['label']}, confidence={result['confidence']}"
        )

        return web.json_response(result)
    except Exception as e:
        logger.error(f"Classification error: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


async def handle_health(request):
    return web.json_response(
        {
            "status": "ok",
            "model": server_instance.model_id if server_instance else DEFAULT_MODEL_ID,
            "base_model": server_instance.base_model_id if server_instance else DEFAULT_BASE_MODEL_ID,
            "device": str(server_instance.device) if server_instance else "not loaded",
        }
    )


def main():
    global server_instance, expected_token

    parser = argparse.ArgumentParser(
        description="Brick Complexity Extractor Server"
    )
    parser.add_argument("--port", type=int, default=8093)
    parser.add_argument("--model-id", type=str, default=os.environ.get("BRICK_COMPLEXITY_MODEL_ID", DEFAULT_MODEL_ID))
    parser.add_argument("--base-model-id", type=str, default=os.environ.get("BRICK_COMPLEXITY_BASE_MODEL_ID", DEFAULT_BASE_MODEL_ID))
    parser.add_argument(
        "--device", type=str, default="auto", choices=["auto", "cuda", "cpu"]
    )
    parser.add_argument(
        "--bearer-token",
        type=str,
        default="",
        help="If set (or BRICK_CLASSIFIER_TOKEN env var), /classify and "
             "/v1/chat/completions require Authorization: Bearer <token>. "
             "/health and /v1/models stay open.",
    )
    args = parser.parse_args()

    expected_token = args.bearer_token or os.environ.get("BRICK_CLASSIFIER_TOKEN", "")
    if expected_token:
        logger.info("Bearer auth enabled on /classify")
    else:
        logger.warning("No bearer token set: /classify is unauthenticated")

    server_instance = BrickComplexityServer(
        model_id=args.model_id,
        base_model_id=args.base_model_id,
        device=args.device,
    )

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/classify", handle_classify)
    app.router.add_post("/v1/chat/completions", handle_openai_chat)
    app.router.add_get("/v1/models", handle_models)
    app.router.add_get("/health", handle_health)

    logger.info(f"Starting server on port {args.port}")
    web.run_app(app, host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()
