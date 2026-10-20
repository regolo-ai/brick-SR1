#!/usr/bin/env python3
"""Interactive terminal chat for regolo/brick-sysone-V1.

Type a query and get the six capability scores that Brick uses for routing.
"""

import argparse
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
DEFAULT_MODEL = "regolo/brick-sysone-V1"
DEFAULT_REVISION = "9263a397a366ee22921214ddeebab1f5e4e8facd"


def build_parser():
    parser = argparse.ArgumentParser(description="Query the SystemOne capability classifier")
    parser.add_argument("query", nargs="*", help="single query (omit for interactive mode)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="model id or local directory")
    parser.add_argument("--revision", default=DEFAULT_REVISION, help="checkpoint revision")
    parser.add_argument("--device", choices=["auto", "cpu", "cuda"], default="auto")
    parser.add_argument("--json", action="store_true", help="emit one JSON object per query")
    parser.add_argument("--bar-width", type=int, default=20, help="bar length in characters")
    return parser


def load(model_id, revision, requested_device):
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    cpu_threads = int(os.environ.get("BRICK_SYSTEMONE_THREADS", min(4, os.cpu_count() or 1)))
    torch.set_num_threads(cpu_threads)

    if requested_device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = requested_device
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    local = os.path.isdir(model_id)
    options = {"local_files_only": True} if local else {"revision": revision}
    model = (
        AutoModelForSequenceClassification.from_pretrained(
            model_id,
            dtype=dtype,
            attn_implementation="sdpa",
            **options,
        )
        .to(device)
        .eval()
    )
    tokenizer = AutoTokenizer.from_pretrained(model_id, **options)
    labels = [model.config.id2label.get(i) for i in range(model.config.num_labels)]
    if labels != LABELS:
        raise SystemExit(f"unexpected label order in checkpoint: {labels}")
    return model, tokenizer, device, min(model.config.max_position_embeddings, 8192)


def classify(model, tokenizer, device, limit, text):
    import torch

    encoded = tokenizer(text, return_tensors="pt", truncation=True, max_length=limit).to(device)
    with torch.inference_mode():
        vector = model(**encoded).logits[0].sigmoid().float().tolist()
    return vector


def render(query, vector, bar_width):
    lines = [f"query: {query}"]
    for label, value in zip(LABELS, vector):
        filled = max(0, min(bar_width, round(value * bar_width)))
        lines.append(f"  {label:<20} {value:.4f}  {'#' * filled}{'.' * (bar_width - filled)}")
    lines.append(f"  vector: [{', '.join(f'{value:.4f}' for value in vector)}]")
    return "\n".join(lines)


def main():
    args = build_parser().parse_args()
    model, tokenizer, device, limit = load(args.model, args.revision, args.device)
    if not args.json:
        print(f"SystemOne ready on {device} (max {limit} tokens). Ctrl-D or 'exit' to quit.", file=sys.stderr)

    def answer(query):
        vector = classify(model, tokenizer, device, limit, query)
        if args.json:
            payload = {"query": query, "vector": vector, "labels": dict(zip(LABELS, vector))}
            print(json.dumps(payload), flush=True)
        else:
            print(render(query, vector, args.bar_width), flush=True)

    if args.query:
        answer(" ".join(args.query))
        return

    def read_query():
        if args.json:
            print("query> ", end="", file=sys.stderr, flush=True)
            line = sys.stdin.readline()
            if not line:
                raise EOFError
            return line.strip()
        return input("query> ").strip()

    while True:
        try:
            query = read_query()
        except (EOFError, KeyboardInterrupt):
            print(file=sys.stderr)
            break
        if not query:
            continue
        if query.lower() in {"exit", "quit"}:
            break
        answer(query)


if __name__ == "__main__":
    main()
