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


def respond(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def main():
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    torch.set_num_threads(int(os.environ.get("BRICK_SYSTEMONE_THREADS", min(4, os.cpu_count() or 1))))
    path = sys.argv[1]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32
    attention = "sdpa"
    if device == "cuda":
        try:
            import flash_attn  # noqa: F401

            attention = "flash_attention_2"
        except ImportError:
            pass
    tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True)
    model = (
        AutoModelForSequenceClassification.from_pretrained(
            path,
            dtype=dtype,
            attn_implementation=attention,
            local_files_only=True,
        )
        .to(device)
        .eval()
    )
    labels = [model.config.id2label.get(i) for i in range(model.config.num_labels)]
    if labels != LABELS:
        raise ValueError("checkpoint labels differ from SystemOne")
    maximum = min(model.config.max_position_embeddings, 8192)
    if maximum <= 0:
        raise ValueError("invalid checkpoint context limit")
    respond({"ready": True, "device": device, "dtype": str(dtype), "attention": attention})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            encoded = tokenizer(
                request["text"],
                return_tensors="pt",
                truncation=True,
                max_length=maximum,
            ).to(device)
            with torch.inference_mode():
                vector = model(**encoded).logits[0].sigmoid().float().tolist()
            respond({"probabilities": vector})
        except Exception as error:
            respond({"error": str(error)})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        respond({"error": str(error)})
        sys.exit(1)
