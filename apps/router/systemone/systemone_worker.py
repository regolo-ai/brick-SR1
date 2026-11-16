"""Persistent local SystemOne inference using the reference PyTorch stack."""

import json
import os
import sys

LABELS = [
    "instruction_following",
    "coding",
    "math_reasoning",
    "world_knowledge",
    "planning_agentic",
    "creative_synthesis",
]

# The classifier only needs the tail of the conversation: the intent lives in
# the latest turns, and attention cost grows quadratically with length.
DEFAULT_MAX_TOKENS = 1024
DEFAULT_MAX_CHARS = 8192
DEFAULT_THREADS = 8


def respond(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def resolve_limit(name, default):
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


def cpu_supports_bf16(torch):
    """Report whether the CPU has BF16 matrix hardware (AMX or AVX512-BF16)."""
    try:
        if torch.backends.cpu.get_cpu_capability() != "AVX512":
            return False
    except Exception:  # noqa: BLE001 - older torch builds lack the probe
        return False
    try:
        with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as handle:
            flags = handle.read().lower()
    except OSError:
        return False
    return "amx_bf16" in flags or "avx512_bf16" in flags


def checkpoint_dtype(path):
    try:
        with open(os.path.join(path, "config.json"), encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError):
        return ""
    return str(config.get("dtype") or config.get("torch_dtype") or "").lower()


def resolve_dtype(torch, device, path):
    requested = os.environ.get("BRICK_SYSTEMONE_DTYPE", "auto").strip().lower()
    if requested in {"bfloat16", "bf16"}:
        return torch.bfloat16
    if requested in {"float32", "fp32"}:
        return torch.float32
    if device == "cuda":
        return torch.bfloat16
    # The pinned checkpoint is stored in BF16. Keeping it there uses the CPU
    # matrix units and halves the resident memory instead of paying for an
    # upcast the model never needed.
    if checkpoint_dtype(path) == "bfloat16" and cpu_supports_bf16(torch):
        return torch.bfloat16
    return torch.float32


def main():
    import time

    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    threads = resolve_limit("BRICK_SYSTEMONE_THREADS", min(DEFAULT_THREADS, os.cpu_count() or 1))
    torch.set_num_threads(threads)
    path = sys.argv[1]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = resolve_dtype(torch, device, path)

    def load(backend, weight_dtype):
        return (
            AutoModelForSequenceClassification.from_pretrained(
                path,
                dtype=weight_dtype,
                attn_implementation=backend,
                local_files_only=True,
            )
            .to(device)
            .eval()
        )

    requested = os.environ.get("BRICK_SYSTEMONE_ATTENTION", "auto").strip().lower()
    if requested not in {"auto", "sdpa", "flash_attention_2"}:
        requested = "auto"
    if requested == "auto":
        if device == "cuda":
            try:
                import flash_attn  # noqa: F401

                model = load("flash_attention_2", dtype)
                attention = "flash_attention_2"
            except Exception as error:  # noqa: BLE001 - fall back to a safe backend
                print(f"flash_attention_2 unavailable, falling back to sdpa: {error}", file=sys.stderr, flush=True)
                model = load("sdpa", dtype)
                attention = "sdpa"
        else:
            model = load("sdpa", dtype)
            attention = "sdpa"
    else:
        model = load(requested, dtype)
        attention = requested

    tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True)
    labels = [model.config.id2label.get(i) for i in range(model.config.num_labels)]
    if labels != LABELS:
        raise ValueError("checkpoint labels differ from SystemOne")
    maximum = min(model.config.max_position_embeddings, resolve_limit("BRICK_SYSTEMONE_MAX_TOKENS", DEFAULT_MAX_TOKENS))
    if maximum <= 0:
        raise ValueError("invalid checkpoint context limit")
    max_chars = resolve_limit("BRICK_SYSTEMONE_MAX_CHARS", DEFAULT_MAX_CHARS)

    def classify(text):
        # Slice before tokenizing: the tokenizer walks the whole string even
        # when truncation keeps a handful of tokens.
        if len(text) > max_chars:
            text = text[-max_chars:]
        encoded = tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=maximum,
        ).to(device)
        with torch.inference_mode():
            return model(**encoded).logits[0].sigmoid().float().tolist()

    warmup_text = "classify the next request and summarize the pending work. " * 64
    started = time.perf_counter()
    try:
        classify(warmup_text)
    except Exception as error:  # noqa: BLE001 - BF16 is unusable on this host
        if dtype == torch.float32:
            raise
        print(f"bfloat16 inference unavailable, falling back to float32: {error}", file=sys.stderr, flush=True)
        dtype = torch.float32
        model = load(attention, dtype)
    warmup_ms = (time.perf_counter() - started) * 1000

    respond(
        {
            "ready": True,
            "device": device,
            "dtype": str(dtype),
            "attention": attention,
            "threads": threads,
            "max_tokens": maximum,
            "max_chars": max_chars,
            "warmup_ms": round(warmup_ms, 2),
        }
    )
    for line in sys.stdin:
        try:
            request = json.loads(line)
            respond({"probabilities": classify(str(request.get("text", "")))})
        except Exception as error:
            respond({"error": str(error)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        respond({"error": str(error)})
        sys.exit(1)
