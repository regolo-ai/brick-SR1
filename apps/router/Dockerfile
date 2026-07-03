# Brick Dockerfile — Single HTTP proxy service (no Envoy)
# Multi-stage build: Rust ML libraries → Go binary → Runtime
# Build from repo root: docker build -f apps/router/Dockerfile -t brick:latest .

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
COPY apps/router/candle-binding/Cargo.toml apps/router/candle-binding/Cargo.loc[k] ./candle-binding/
RUN cd candle-binding && \
    mkdir -p src && echo "pub fn _dummy() {}" > src/lib.rs && \
    cargo build --release --no-default-features && \
    rm -rf src

# Build candle-binding
COPY apps/router/candle-binding/src/ ./candle-binding/src/
RUN cd candle-binding && \
    find src -name "*.rs" -exec touch {} + && \
    cargo build --release --no-default-features

# ─── Stage 1b: Build ml-binding (Linfa ML) ───
FROM --platform=$BUILDPLATFORM rust:1.90-bookworm AS ml-builder

RUN apt-get update && apt-get install -y build-essential pkg-config && \
    rm -rf /var/lib/apt/lists/*

ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

WORKDIR /app

COPY apps/router/ml-binding/Cargo.toml apps/router/ml-binding/Cargo.loc[k] ./ml-binding/
RUN cd ml-binding && \
    mkdir -p src && echo "pub fn _dummy() {}" > src/lib.rs && \
    cargo build --release && rm -rf src

COPY apps/router/ml-binding/src/ ./ml-binding/src/
RUN cd ml-binding && \
    find src -name "*.rs" -exec touch {} + && \
    cargo build --release

# ─── Stage 1c: Build nlp-binding (BM25 + N-gram) ───
FROM --platform=$BUILDPLATFORM rust:1.90-bookworm AS nlp-builder

RUN apt-get update && apt-get install -y build-essential pkg-config && \
    rm -rf /var/lib/apt/lists/*

ENV CARGO_NET_GIT_FETCH_WITH_CLI=true

WORKDIR /app

COPY apps/router/nlp-binding/Cargo.toml apps/router/nlp-binding/Cargo.loc[k] ./nlp-binding/
RUN cd nlp-binding && \
    mkdir -p src && echo "pub fn _dummy() {}" > src/lib.rs && \
    cargo build --release && rm -rf src

COPY apps/router/nlp-binding/src/ ./nlp-binding/src/
RUN cd nlp-binding && \
    find src -name "*.rs" -exec touch {} + && \
    cargo build --release

# ─── Stage 2: Build Go binary ───
FROM --platform=$BUILDPLATFORM golang:1.24-bookworm AS go-builder

# Install dependencies for CGO and linking
RUN apt-get update && apt-get install -y libssl-dev build-essential pkg-config file && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create a centralized folder for all .so libraries
RUN mkdir -p /app/libs

# Copy module files and binding sources (including .h headers)
COPY apps/router/candle-binding/ ./candle-binding/
COPY apps/router/ml-binding/ ./ml-binding/
COPY apps/router/nlp-binding/ ./nlp-binding/
COPY apps/router/src/spatial-router/go.mod apps/router/src/spatial-router/go.sum ./src/spatial-router/

# Copy compiled libraries from Rust stages to centralized libs folder
COPY --from=rust-builder /app/candle-binding/target/release/libcandle_spatial_router.so /app/libs/
COPY --from=ml-builder /app/ml-binding/target/release/libml_spatial_router.so /app/libs/
COPY --from=nlp-builder /app/nlp-binding/target/release/libnlp_binding.so /app/libs/

# Download Go dependencies
RUN cd src/spatial-router && go mod download

# Copy Go source code
COPY apps/router/src/spatial-router/ ./src/spatial-router/

ENV CGO_ENABLED=1
ENV GOOS=linux
# Set library path for the linker during build time
ENV LD_LIBRARY_PATH=/app/libs

# Build the proxy binary
# CGO_CFLAGS includes binding directories for header discovery
RUN cd src/spatial-router && \
    CGO_CFLAGS="-I/app/candle-binding -I/app/ml-binding -I/app/nlp-binding" \
    CGO_LDFLAGS="-L/app/libs -lcandle_spatial_router -lml_spatial_router -lnlp_binding" \
    go build -ldflags="-w -s" -o /app/bin/brick cmd/main.go

# ─── Stage 3: Runtime ───
FROM debian:bookworm-slim

# Install runtime dependencies and Python for HuggingFace
RUN apt-get update && apt-get install -y \
    ca-certificates \
    openssl \
    python3 \
    python3-pip \
    && pip3 install --break-system-packages --no-cache-dir huggingface_hub[cli] \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled binary
COPY --from=go-builder /app/bin/brick /app/brick

# Copy .so libraries to system path and update linker
COPY --from=go-builder /app/libs/*.so /usr/local/lib/
RUN ldconfig

# Copy configuration. pricing.yaml must sit next to config.yaml: the router
# resolves the pricing table at filepath.Join(dir(configPath), "pricing.yaml"),
# and without it GET /api/v1/economics degrades to token counts only.
COPY apps/router/config/config.yaml /app/config/
COPY pricing.yaml /app/config/

# Expose required ports
# Brick HTTP proxy port
EXPOSE 8000
# Metrics port
EXPOSE 9190
# API server port
EXPOSE 8080

ENTRYPOINT ["/app/brick", "--config", "/app/config/config.yaml"]
