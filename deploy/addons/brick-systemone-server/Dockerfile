# Brick SystemOne vector server — CPU variant (dev/test only; 8192 ctx is slow on CPU).

FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/root/.cache/huggingface

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --upgrade pip \
    && pip install -r requirements.txt

COPY server.py .

EXPOSE 8095

HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=20 \
    CMD curl -f http://localhost:8095/health || exit 1

CMD ["--port", "8095", "--device", "auto"]
