# Brick CPU capability classifier

This crate implements the pinned six-label ModernBERT inference path used by the
Go router. It loads local assets and performs no downloads. The C ABI has two
functions: `brick_model_load` and `brick_classify`. Callers supply their own
error
and output buffers; results contain exactly six finite values on success.
Inference is serialized by the model mutex. Ordinary errors return a failure
status and do not modify the output buffer.

Build with `cargo build --release --locked`. The Go wrapper links the shared
library from `target/release`; distribution bundles provide a relative loader
path through `scripts/build_runtime.py`.

The extraction preserves the existing CPU algorithm, including 512-token
truncation, mean pooling, the checkpoint head, softmax and RoPE normalization.
The test corpus in `testdata/capability-baseline.json` records outputs before
extraction. Model-math corrections must be reviewed separately from packaging.
