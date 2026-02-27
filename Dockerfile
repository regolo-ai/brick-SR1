# MyModel Dockerfile — Single HTTP proxy service (no Envoy)
# Multi-stage build: Rust ML libraries → Go binary → Runtime

# ─── Stage 1: Build Rust candle-binding (ML embeddings) ───
ARG BUILDPLATFORM
FROM --platform=$BUILDPLATFORM rust:1.90-bookworm AS rust-builder

RUN apt-get update && apt-get install -y \
    make build-essential pkg-config libssl-dev && \
    rm -rf /var/lib/apt/lists/*

ENV CARGO_NET_GIT_FETCH_WITH_CLI=true
ENV CARGO_INCREMENTAL=1
ENV CARGO_PROFILE_RELEASE_LTO=thin

WORKDIR /app

# Cache Rust dependencies
COPY candle-binding/Cargo.toml candle-binding/Cargo.loc[k] ./candle-binding/
RUN cd candle-binding && \
    mkdir -p src && echo "pub fn _dummy() {}" > src/lib.rs && \
    cargo build --release --no-default-features && \
    rm -rf src

# Build candle-binding
COPY candle-binding/src/ ./candle-binding/src/
RUN cd candle-binding && \
    find target -name "libcandle_semantic_router.so" -delete 2>/dev/null; \
    cargo build --release --no-default-features && \
    find target -name "libcandle_semantic_router.so" -type f -exec ls -la {} \;

# ─── Stage 1b: Build ml-binding (Linfa ML) ───
FROM --platform=$BUILDPLATFORM rust:1.90-bookworm AS ml-builder

RUN apt-get update && apt-get install -y build-essential pkg-config && \
    rm -rf /var/lib/apt/lists/*

ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

WORKDIR /app

COPY ml-binding/Cargo.toml ml-binding/Cargo.loc[k] ./ml-binding/
RUN cd ml-binding && \
    mkdir -p src && echo "pub fn _dummy() {}" > src/lib.rs && \
    cargo build --release && rm -rf src

COPY ml-binding/src/ ./ml-binding/src/
RUN cd ml-binding && \
    find target -name "libml_semantic_router.so" -delete 2>/dev/null; \
    cargo build --release

# ─── Stage 1c: Build nlp-binding (BM25 + N-gram) ───
FROM --platform=$BUILDPLATFORM rust:1.90-bookworm AS nlp-builder

RUN apt-get update && apt-get install -y build-essential pkg-config && \
    rm -rf /var/lib/apt/lists/*

ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

WORKDIR /app

COPY nlp-binding/Cargo.toml nlp-binding/Cargo.loc[k] ./nlp-binding/
RUN cd nlp-binding && \
    mkdir -p src && echo "pub fn _dummy() {}" > src/lib.rs && \
    cargo build --release && rm -rf src

COPY nlp-binding/src/ ./nlp-binding/src/
RUN cd nlp-binding && \
    find target -name "libnlp_binding.so" -delete 2>/dev/null; \
    cargo build --release

# ─── Stage 2: Build Go binary ───
FROM --platform=$BUILDPLATFORM golang:1.24-bookworm AS go-builder

RUN apt-get update && apt-get install -y libssl-dev file && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy Go module files for dependency caching
RUN mkdir -p src/semantic-router
COPY src/semantic-router/go.mod src/semantic-router/go.sum src/semantic-router/
COPY candle-binding/go.mod candle-binding/semantic-router.go candle-binding/
COPY ml-binding/go.mod ml-binding/ml_binding.go ml-binding/
COPY nlp-binding/go.mod nlp-binding/nlp_binding.go nlp-binding/nlp_binding_mock.go nlp-binding/

RUN cd src/semantic-router && go mod download

# Copy source code
COPY src/semantic-router/ src/semantic-router/

# Copy Rust libraries
COPY --from=rust-builder /app/candle-binding/target/release/libcandle_semantic_router.so /app/candle-binding/target/release/
COPY --from=ml-builder /app/ml-binding/target/release/libml_semantic_router.so /app/ml-binding/target/release/
COPY --from=nlp-builder /app/nlp-binding/target/release/libnlp_binding.so /app/nlp-binding/target/release/

ENV CGO_ENABLED=1
ENV LD_LIBRARY_PATH=/app/candle-binding/target/release:/app/ml-binding/target/release:/app/nlp-binding/target/release
ENV GOOS=linux

# Build the MyModel proxy binary
RUN cd src/semantic-router && \
    CGO_CFLAGS="-I/app/candle-binding" \
    CGO_LDFLAGS="-L/app/candle-binding/target/release -L/app/ml-binding/target/release -L/app/nlp-binding/target/release -lcandle_semantic_router -lml_semantic_router -lnlp_binding" \
    go build -ldflags="-w -s" -o /app/bin/mymodel cmd/main.go

# ─── Stage 3: Runtime ───
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates openssl python3 python3-pip && \
    pip3 install --break-system-packages --no-cache-dir huggingface_hub[cli] && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=go-builder /app/bin/mymodel /app/mymodel
COPY --from=go-builder /app/candle-binding/target/release/libcandle_semantic_router.so /app/lib/
COPY --from=go-builder /app/ml-binding/target/release/libml_semantic_router.so /app/lib/
COPY --from=go-builder /app/nlp-binding/target/release/libnlp_binding.so /app/lib/
COPY config/config.yaml /app/config/

ENV LD_LIBRARY_PATH=/app/lib

# MyModel HTTP proxy port (replaces Envoy + ExtProc)
EXPOSE 8000
# Metrics port
EXPOSE 9190
# API server port
EXPOSE 8080

ENTRYPOINT ["/app/mymodel", "--config", "/app/config/config.yaml"]
