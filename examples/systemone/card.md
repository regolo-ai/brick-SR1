## Quickstart

Install (PyTorch index follows the local CUDA driver, CPU fallback):

```bash
python3 -m venv .venv-systemone
.venv-systemone/bin/python -m pip install --upgrade pip
.venv-systemone/bin/python -m pip install --index-url https://download.pytorch.org/whl/cu128 torch==2.11.0
.venv-systemone/bin/python -m pip install transformers==5.20.2 safetensors==0.8.0 tokenizers==0.23.3 numpy==1.26.4 huggingface-hub==2.2.0
```

Use `https://download.pytorch.org/whl/cu126` for driver 560-569, or
`https://download.pytorch.org/whl/cpu` for CPU-only.

Terminal chat: type a query, read the six capability scores.

```python
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

LABELS = ["instruction_following", "coding", "math_reasoning",
          "world_knowledge", "planning_agentic", "creative_synthesis"]
REVISION = "9263a397a366ee22921214ddeebab1f5e4e8facd"

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.bfloat16 if device == "cuda" else torch.float32
model = AutoModelForSequenceClassification.from_pretrained(
    "regolo/brick-sysone-V1", revision=REVISION, dtype=dtype,
    attn_implementation="sdpa",
).to(device).eval()
tokenizer = AutoTokenizer.from_pretrained("regolo/brick-sysone-V1", revision=REVISION)
limit = min(model.config.max_position_embeddings, 8192)

while True:
    try:
        query = input("query> ").strip()
    except (EOFError, KeyboardInterrupt):
        break
    if not query:
        continue
    encoded = tokenizer(query, return_tensors="pt", truncation=True, max_length=limit).to(device)
    with torch.inference_mode():
        vector = model(**encoded).logits[0].sigmoid().float().tolist()
    for label, value in zip(LABELS, vector):
        print(f"  {label:<20} {value:.4f}")
    print(f"  vector: [{', '.join(f'{v:.4f}' for v in vector)}]")
```

```
query> write a python parser that streams csv rows
  instruction_following 0.5117
  coding                0.9258
  math_reasoning        0.0903
  world_knowledge       0.1157
  planning_agentic      0.0630
  creative_synthesis    0.0198
  vector: [0.5117, 0.9258, 0.0903, 0.1157, 0.0630, 0.0198]
```

Each value is an independent sigmoid in `[0, 1]`: the output is a capability
profile, not a distribution over models. Order is fixed and matches
`LABELS`. Context is truncated to 8192 tokens; Brick classifies only the last
user message. Full version with `--json`, `--device` and one-shot mode:
`examples/systemone/chat.py`.
