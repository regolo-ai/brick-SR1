# Local SystemOne inference

The Go adapter uses a persistent local Python process running PyTorch and Hugging
Face Transformers, following the SystemOne reference `farm/vec.py` implementation.
It uses FP32 on CPU, BF16 on CUDA, FlashAttention 2 when available on CUDA, and
SDPA otherwise. It loads verified local safetensors and tokenizer assets, uses
mean pooling and six independent sigmoid outputs, and truncates at the
checkpoint's context limit (8192 tokens for the pinned v2 model). Routing uses
unrounded values in checkpoint label order.

Install Python dependencies in an environment of your choice:

```bash
python3 -m venv /path/to/systemone-env
/path/to/systemone-env/bin/python -m pip install -r apps/router/systemone/requirements.txt
export BRICK_SYSTEMONE_PYTHON=/path/to/systemone-env/bin/python
```

Without `BRICK_SYSTEMONE_PYTHON`, the runtime uses `python3` on PATH. An optional
`BRICK_SYSTEMONE_THREADS` controls PyTorch CPU threads (default: at most four).
Install FlashAttention separately if desired on a supported CUDA system.
The installer checks actual model loading; missing Python dependencies fail
explicitly. The worker never downloads assets or reads Hub credentials.
Checkpoint downloads remain the installer's responsibility. The pinned checkpoint
is public, so downloads work anonymously; an optional `HF_TOKEN` is forwarded when
present, and checksum-verified `BRICK_MODEL_ASSETS` supports offline installs.

Go embeds the worker source in the runtime binary. Requests are serialized to
keep one model resident. Worker startup, protocol, timeout and inference errors
return errors to the router. There is no fallback inference engine.
