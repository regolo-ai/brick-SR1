# Local SystemOne inference

The Go adapter uses a persistent local Python process running PyTorch and Hugging
Face Transformers, following the SystemOne reference `farm/vec.py` implementation.
It runs BF16 on CUDA and, on CPU, keeps the checkpoint's native BF16 weights when
the host has BF16 matrix units (AMX or AVX512-BF16); otherwise it uses FP32.
FlashAttention 2 is used when available on CUDA, SDPA otherwise. It loads verified
local safetensors and tokenizer assets, uses mean pooling and six independent
sigmoid outputs, and bounds each request to the checkpoint's context limit and a
smaller routing budget (1024 tokens for the pinned v2 model). Routing uses
unrounded values in checkpoint label order.

Install Python dependencies in an environment of your choice:

```bash
python3 -m venv /path/to/systemone-env
/path/to/systemone-env/bin/python -m pip install -r apps/router/systemone/requirements.txt
export BRICK_SYSTEMONE_PYTHON=/path/to/systemone-env/bin/python
```

Without `BRICK_SYSTEMONE_PYTHON`, the runtime uses `python3` on PATH.

Tuning knobs:

| Variable | Default | Effect |
|---|---|---|
| `BRICK_SYSTEMONE_THREADS` | `min(8, cores)` | PyTorch CPU threads |
| `BRICK_SYSTEMONE_DTYPE` | `auto` | `auto`, `bfloat16` or `float32` weights |
| `BRICK_SYSTEMONE_MAX_TOKENS` | `1024` | tokens fed to the classifier |
| `BRICK_SYSTEMONE_MAX_CHARS` | `8192` | characters kept before tokenizing |
| `BRICK_SYSTEMONE_ATTENTION` | `auto` | `auto`, `sdpa` or `flash_attention_2` |
| `BRICK_SYSTEMONE_TIMEOUT` | `180` | seconds per inference round-trip |

Install FlashAttention separately if desired on a supported CUDA system.
The installer checks actual model loading; missing Python dependencies fail
explicitly. The worker never downloads assets or reads Hub credentials.
Checkpoint downloads remain the installer's responsibility. The pinned checkpoint
is public, so downloads work anonymously; an optional `HF_TOKEN` is forwarded when
present, and checksum-verified `BRICK_MODEL_ASSETS` supports offline installs.

The worker warms up one inference before reporting ready, so the first routed
request never pays kernel initialization. Go embeds the worker source in the
runtime binary. Requests are serialized to keep one model resident; identical
concurrent texts share a single inference and recent results are cached. Worker
startup, protocol, timeout and inference errors return errors to the router.
There is no fallback inference engine.
