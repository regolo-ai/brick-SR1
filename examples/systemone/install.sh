#!/usr/bin/env bash
# Install a local Python environment for regolo/brick-sysone-V1.
set -euo pipefail

VENV="${VENV:-.venv-systemone}"
REVISION="${REVISION:-9263a397a366ee22921214ddeebab1f5e4e8facd}"
TORCH_VERSION="${TORCH_VERSION:-2.11.0}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required" >&2
  exit 1
fi

driver_version() {
  command -v nvidia-smi >/dev/null 2>&1 || return 1
  nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -n 1 | cut -d. -f1
}

index_url() {
  if [ "${FORCE_CPU:-0}" = "1" ]; then
    echo "https://download.pytorch.org/whl/cpu"
    return
  fi
  major="$(driver_version || true)"
  if [ -z "${major}" ]; then
    echo "https://download.pytorch.org/whl/cpu"
  elif [ "${major}" -ge 570 ]; then
    echo "https://download.pytorch.org/whl/cu128"
  elif [ "${major}" -ge 560 ]; then
    echo "https://download.pytorch.org/whl/cu126"
  else
    echo "https://download.pytorch.org/whl/cpu"
  fi
}

INDEX="$(index_url)"
echo "Installing SystemOne into ${VENV} (torch index: ${INDEX})"

python3 -m venv "${VENV}"
"${VENV}/bin/python" -m pip install --quiet --upgrade pip

"${VENV}/bin/python" -m pip install --quiet \
  --index-url "${INDEX}" \
  "torch==${TORCH_VERSION}"

"${VENV}/bin/python" -m pip install --quiet \
  "transformers==5.20.2" \
  "safetensors==0.8.0" \
  "tokenizers==0.23.3" \
  "numpy==1.26.4" \
  "huggingface-hub==2.2.0"

"${VENV}/bin/python" - "${REVISION}" <<'PY'
import sys
from huggingface_hub import snapshot_download

snapshot_download(
    "regolo/brick-sysone-V1",
    revision=sys.argv[1],
    allow_patterns=["*.json", "*.safetensors", "*.txt"],
)
PY

echo
echo "Done. Start the terminal chat with:"
echo "  ${VENV}/bin/python examples/systemone/chat.py"
