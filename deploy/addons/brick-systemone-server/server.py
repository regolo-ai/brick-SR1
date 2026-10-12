#!/usr/bin/env python3
"""
Brick SystemOne Vector Server

Serves a fine-tuned ModernBERT-large sequence classifier (query -> final_vector,
6-dim soft capability assignment) over HTTP for the Brick Go router.

Endpoints:
  POST /vectors  {"text": "..."} → {"vectors": [6 floats], "model": "...", "latency_ms": ...}
  GET  /health   → {"status": "ok", "model": "...", "device": "...", "max_length": 8192}

Usage:
  python server.py --port 8095
  python server.py --port 8095 --device cuda --model-id massaindustries/brick-systemone-large
"""
import argparse
import hmac
import logging
import os
import time

import torch
import torch.nn.functional as F
from aiohttp import web
from transformers import AutoModelForSequenceClassification, AutoTokenizer

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

DEFAULT_MODEL_ID = "massaindustries/brick-systemone-large-v2"
DEFAULT_MAX_LENGTH = 8192

DIMS = ["instruction_following", "coding", "math_reasoning",
        "world_knowledge", "planning_agentic", "creative_synthesis"]


class SystemOneVectorServer:
    def __init__(self, model_id=DEFAULT_MODEL_ID, max_length=DEFAULT_MAX_LENGTH,
                 device="auto"):
        self.model_id = model_id
        self.max_length = max_length

        if device == "auto":
            self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        else:
            self.device = torch.device(device)

        dtype = torch.bfloat16 if self.device.type == "cuda" else torch.float32

        logger.info(f"Loading tokenizer {model_id}...")
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)

        logger.info(f"Loading model {model_id} on {self.device} ({dtype})...")
        start = time.time()
        try:
            import flash_attn  # noqa: F401
            attn = "flash_attention_2"
        except ImportError:
            attn = "sdpa"
        self.model = AutoModelForSequenceClassification.from_pretrained(
            model_id, torch_dtype=dtype, attn_implementation=attn,
        )
        self.model.to(self.device)
        self.model.eval()
        # Warmup: absorb first-call CUDA init cost at startup, not on traffic.
        with torch.no_grad():
            warm = self.tokenizer("warmup", return_tensors="pt").to(self.device)
            _ = self.model(**warm).logits
        if self.device.type == "cuda":
            torch.cuda.synchronize()
        logger.info(f"Model loaded in {time.time() - start:.1f}s (attn={attn})")

    @torch.no_grad()
    def vectors(self, text: str) -> dict:
        inputs = self.tokenizer(
            text, return_tensors="pt", truncation=True,
            max_length=self.max_length,
        ).to(self.device)
        logits = self.model(**inputs).logits[0]
        probs = torch.sigmoid(logits).float().tolist()
        return {"vectors": [round(float(v), 4) for v in probs], "dims": DIMS}


server_instance: SystemOneVectorServer | None = None
expected_token: str = ""


@web.middleware
async def auth_middleware(request, handler):
    # /health stays open for probes; /vectors is the only authenticated endpoint
    if expected_token and request.path == "/vectors":
        header = request.headers.get("Authorization", "")
        prefix = "Bearer "
        if not header.startswith(prefix) or not hmac.compare_digest(
            header[len(prefix):], expected_token
        ):
            return web.json_response({"error": "unauthorized"}, status=401)
    return await handler(request)


async def handle_vectors(request):
    try:
        data = await request.json()
        text = data.get("text", "")
        if not text or not text.strip():
            return web.json_response({"error": "No text provided"}, status=400)

        start = time.time()
        result = server_instance.vectors(text)
        elapsed_ms = (time.time() - start) * 1000
        result["model"] = server_instance.model_id
        result["latency_ms"] = round(elapsed_ms, 1)

        logger.info(f"Vectors in {elapsed_ms:.1f}ms (len={len(text)})")
        return web.json_response(result)
    except Exception as e:
        logger.error(f"Vectors error: {e}", exc_info=True)
        return web.json_response({"error": str(e)}, status=500)


async def handle_health(request):
    return web.json_response(
        {
            "status": "ok",
            "model": server_instance.model_id if server_instance else DEFAULT_MODEL_ID,
            "device": str(server_instance.device) if server_instance else "not loaded",
            "max_length": server_instance.max_length if server_instance else DEFAULT_MAX_LENGTH,
        }
    )


def main():
    global server_instance, expected_token

    parser = argparse.ArgumentParser(description="Brick SystemOne Vector Server")
    parser.add_argument("--port", type=int, default=8095)
    parser.add_argument("--model-id", type=str,
                        default=os.environ.get("BRICK_SYSTEMONE_MODEL_ID", DEFAULT_MODEL_ID))
    parser.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
    parser.add_argument("--device", type=str, default="auto", choices=["auto", "cuda", "cpu"])
    parser.add_argument(
        "--bearer-token", type=str, default="",
        help="If set (or BRICK_CLASSIFIER_TOKEN env var), /vectors requires "
             "Authorization: Bearer <token>. /health stays open.",
    )
    args = parser.parse_args()

    expected_token = args.bearer_token or os.environ.get("BRICK_CLASSIFIER_TOKEN", "")
    if expected_token:
        logger.info("Bearer auth enabled on /vectors")
    else:
        logger.warning("No bearer token set: /vectors is unauthenticated")

    server_instance = SystemOneVectorServer(
        model_id=args.model_id, max_length=args.max_length, device=args.device,
    )

    app = web.Application(middlewares=[auth_middleware])
    app.router.add_post("/vectors", handle_vectors)
    app.router.add_get("/health", handle_health)

    logger.info(f"Starting server on port {args.port}")
    web.run_app(app, host="0.0.0.0", port=args.port)


if __name__ == "__main__":
    main()
