# MyModel — Fork & Modify Plan for Claude Code

## STRATEGY: Fork vLLM SR, gut Envoy, add our proxy

Instead of rewriting from scratch, we fork `vllm-project/semantic-router` and:
1. **KEEP**: candle-binding (Rust ML), signal extraction, decision engine, plugin chain, config system, dashboard
2. **REMOVE**: Envoy proxy, ExtProc gRPC, Kubernetes/Helm, everything Envoy-related
3. **ADD**: Direct HTTP proxy in Go (replaces Envoy), modality detection, multi-provider support, simplified config
4. **RENAME**: Brand as MyModel

This saves months of work. All the ML, signals, decisions, PII, jailbreak — already written and tested.

---

## STEP 0: FORK AND CLONE

```bash
# Fork on GitHub: github.com/vllm-project/semantic-router → github.com/massaindustries/mymodel
git clone https://github.com/massaindustries/mymodel
cd mymodel
git checkout -b mymodel-v1
```

---

## STEP 1: UNDERSTAND THE REPO STRUCTURE — WHAT TO KEEP VS REMOVE

```
vllm-project/semantic-router/
│
├── candle-binding/              ✅ KEEP — This is the ML core (Rust)
│   ├── src/
│   │   ├── lib.rs               ✅ FFI entry points  
│   │   ├── classifier.rs        ✅ DualPathUnifiedClassifier
│   │   ├── embedding.rs         ✅ Embedding inference
│   │   ├── lora_adapter.rs      ✅ LoRA management
│   │   └── ...
│   ├── Cargo.toml               ✅
│   ├── classifier.go            ✅ Go CGO bindings to Rust
│   ├── embedding.go             ✅
│   └── go.mod                   ✅
│
├── src/semantic-router/         ✅ KEEP + MODIFY — Go router logic
│   ├── pkg/
│   │   ├── config/
│   │   │   └── config.go        ✅ KEEP + EXTEND (add providers, modality routes)
│   │   ├── classification/
│   │   │   └── classifier.go    ✅ KEEP — Signal extraction orchestration
│   │   ├── decision/
│   │   │   └── engine.go        ✅ KEEP — Decision engine (AND/OR + priority)
│   │   ├── extproc/             ⚠️ HEAVY MODIFY — Replace ExtProc with HTTP handlers
│   │   │   ├── router.go        ⚠️ Was gRPC ExtProc server → becomes HTTP router
│   │   │   ├── processor_req_body.go    ✅ KEEP logic, change interface
│   │   │   ├── processor_req_header.go  ❌ REMOVE (Envoy-specific)
│   │   │   ├── processor_res_body.go    ⚠️ KEEP post-processing logic
│   │   │   ├── processor_res_header.go  ❌ REMOVE (Envoy-specific)
│   │   │   ├── req_filter_classification.go  ✅ KEEP — Core classification pipeline
│   │   │   ├── req_filter_jailbreak.go       ✅ KEEP
│   │   │   ├── req_filter_pii.go             ✅ KEEP
│   │   │   └── ...
│   │   ├── cache/               ✅ KEEP — Semantic cache
│   │   ├── headers/             ❌ REMOVE (Envoy x-vsr-* headers)
│   │   ├── observability/       ✅ KEEP — Logging, metrics
│   │   └── ...
│   ├── cmd/
│   │   └── main.go              ⚠️ REWRITE — New entry point
│   └── go.mod                   ✅ MODIFY (update module name)
│
├── src/vllm-sr/                 ⚠️ MODIFY — Python CLI wrapper
│   ├── cli/
│   │   └── main.py              ⚠️ Rename commands, update branding
│   └── ...
│
├── config/
│   ├── config.yaml              ⚠️ EXTEND — Add providers, modality_routes sections
│   └── envoy.yaml               ❌ REMOVE
│   └── envoy-docker.yaml        ❌ REMOVE
│
├── dashboard/                   ✅ KEEP — React frontend + Go backend
│   ├── frontend/                ✅
│   └── backend/                 ⚠️ MODIFY — Remove Envoy proxy, point to our router
│
├── deploy/
│   ├── docker-compose/          ⚠️ SIMPLIFY — Remove Envoy container
│   ├── kubernetes/              ✅ KEEP (optional, for users who want K8s)
│   └── envoy/                   ❌ REMOVE
│
├── Dockerfile                   ⚠️ MODIFY — Remove Envoy
├── Dockerfile.extproc           ❌ REMOVE
├── Makefile                     ⚠️ MODIFY — Update targets
├── scripts/                     ✅ KEEP
├── e2e-tests/                   ⚠️ MODIFY — Point to new HTTP port
├── bench/                       ✅ KEEP
└── tools/                       ✅ KEEP
```

---

## STEP 2: REMOVE ENVOY

These are the files and references to delete entirely.

```bash
# Delete Envoy config files
rm -f config/envoy.yaml
rm -f config/envoy-docker.yaml
rm -f config/envoy-docker-compose.yaml
rm -rf deploy/envoy/

# Delete ExtProc-specific Dockerfile
rm -f Dockerfile.extproc
rm -f Dockerfile.extproc.cross

# Delete Envoy-specific header handling
rm -f src/semantic-router/pkg/headers/headers.go

# Delete ExtProc gRPC-specific files (keep the filter logic!)
rm -f src/semantic-router/pkg/extproc/processor_req_header.go
rm -f src/semantic-router/pkg/extproc/processor_res_header.go

# Delete Kubernetes Envoy Gateway resources (keep base K8s manifests)
rm -rf deploy/kubernetes/ai-gateway/
```

In `go.mod`, remove these dependencies (will happen naturally after code changes):
- `google.golang.org/grpc` (ExtProc gRPC)
- Any `envoy` or `ext_proc` proto imports

---

## STEP 3: CREATE THE HTTP PROXY (replaces Envoy + ExtProc)

This is the core new code. Create a new package:

### 3.1 Create `src/semantic-router/pkg/proxy/` directory

```bash
mkdir -p src/semantic-router/pkg/proxy
```

### 3.2 `src/semantic-router/pkg/proxy/server.go` — Main HTTP server

```go
package proxy

import (
    "encoding/json"
    "fmt"
    "io"
    "log"
    "net/http"
    "strings"
    "time"

    "github.com/massaindustries/mymodel/src/semantic-router/pkg/config"
    "github.com/massaindustries/mymodel/src/semantic-router/pkg/routing"
)

type Server struct {
    config   *config.RouterConfig
    router   *routing.Router
    client   *http.Client
    port     int
}

func NewServer(cfg *config.RouterConfig, router *routing.Router, port int) *Server {
    return &Server{
        config: cfg,
        router: router,
        client: &http.Client{
            Timeout: 5 * time.Minute, // LLM responses can be slow
        },
        port: port,
    }
}

func (s *Server) Start() error {
    mux := http.NewServeMux()

    // OpenAI-compatible endpoints
    mux.HandleFunc("/v1/chat/completions", s.handleChatCompletions)
    mux.HandleFunc("/v1/models", s.handleListModels)
    mux.HandleFunc("/health", s.handleHealth)
    mux.HandleFunc("/v1/routing/test", s.handleRoutingTest)

    // CORS middleware
    handler := corsMiddleware(mux)

    addr := fmt.Sprintf(":%d", s.port)
    log.Printf("MyModel listening on http://0.0.0.0%s", addr)
    log.Printf("Virtual model: %s", s.config.Model.Name)
    return http.ListenAndServe(addr, handler)
}

func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
    if r.Method != http.MethodPost {
        http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
        return
    }

    start := time.Now()

    // Parse request body
    body, err := io.ReadAll(r.Body)
    if err != nil {
        writeError(w, "Failed to read request body", http.StatusBadRequest)
        return
    }
    defer r.Body.Close()

    var req ChatCompletionRequest
    if err := json.Unmarshal(body, &req); err != nil {
        writeError(w, "Invalid JSON", http.StatusBadRequest)
        return
    }

    // Determine if we should route or passthrough
    shouldRoute := req.Model == s.config.Model.Name ||
        req.Model == "MoM" ||
        req.Model == "auto"

    var target RoutingTarget
    if shouldRoute {
        // Run the full routing pipeline (signals → decisions → plugins)
        target = s.router.Route(&req)
    } else {
        // Client specified a specific model — find provider
        target = s.router.FindModel(req.Model)
    }

    // Check if blocked by plugins
    if target.Blocked {
        writeError(w, target.BlockReason, http.StatusForbidden)
        return
    }

    routingLatency := time.Since(start)
    log.Printf("[route] %s → %s/%s (%s, %dms)",
        req.Model, target.Provider, target.Model,
        target.Reason, routingLatency.Milliseconds())

    // Replace model name in the body for forwarding
    modifiedBody := replaceModelInBody(body, target.Model)

    // Proxy to the target provider
    s.proxyRequest(w, r, target, modifiedBody)
}

func (s *Server) proxyRequest(
    w http.ResponseWriter,
    originalReq *http.Request,
    target RoutingTarget,
    body []byte,
) {
    provider := s.config.GetProvider(target.Provider)
    if provider == nil {
        writeError(w, fmt.Sprintf("Provider '%s' not configured", target.Provider),
            http.StatusInternalServerError)
        return
    }

    // Build upstream URL
    baseURL := strings.TrimRight(provider.BaseURL, "/")
    upstreamURL := baseURL + "/chat/completions"

    // Create upstream request
    upReq, err := http.NewRequest("POST", upstreamURL, strings.NewReader(string(body)))
    if err != nil {
        writeError(w, "Failed to create upstream request", http.StatusInternalServerError)
        return
    }

    // Set headers
    upReq.Header.Set("Content-Type", "application/json")
    if provider.APIKey != "" {
        if provider.Type == "anthropic" {
            upReq.Header.Set("x-api-key", provider.APIKey)
            upReq.Header.Set("anthropic-version", "2023-06-01")
        } else {
            upReq.Header.Set("Authorization", "Bearer "+provider.APIKey)
        }
    }

    // For streaming: we need to flush chunks immediately
    isStreaming := strings.Contains(string(body), `"stream":true`) ||
        strings.Contains(string(body), `"stream": true`)

    if isStreaming {
        s.proxyStreaming(w, upReq)
    } else {
        s.proxyNonStreaming(w, upReq)
    }
}

func (s *Server) proxyNonStreaming(w http.ResponseWriter, upReq *http.Request) {
    resp, err := s.client.Do(upReq)
    if err != nil {
        writeError(w, fmt.Sprintf("Upstream error: %v", err), http.StatusBadGateway)
        return
    }
    defer resp.Body.Close()

    // Copy headers
    for key, values := range resp.Header {
        for _, v := range values {
            w.Header().Add(key, v)
        }
    }
    w.WriteHeader(resp.StatusCode)

    // Copy body
    io.Copy(w, resp.Body)
}

func (s *Server) proxyStreaming(w http.ResponseWriter, upReq *http.Request) {
    resp, err := s.client.Do(upReq)
    if err != nil {
        writeError(w, fmt.Sprintf("Upstream error: %v", err), http.StatusBadGateway)
        return
    }
    defer resp.Body.Close()

    // Set SSE headers
    w.Header().Set("Content-Type", "text/event-stream")
    w.Header().Set("Cache-Control", "no-cache")
    w.Header().Set("Connection", "keep-alive")
    w.WriteHeader(resp.StatusCode)

    // Flush each chunk immediately
    flusher, ok := w.(http.Flusher)
    if !ok {
        io.Copy(w, resp.Body)
        return
    }

    buf := make([]byte, 4096)
    for {
        n, err := resp.Body.Read(buf)
        if n > 0 {
            w.Write(buf[:n])
            flusher.Flush()
        }
        if err != nil {
            break
        }
    }
}

func (s *Server) handleListModels(w http.ResponseWriter, r *http.Request) {
    models := []map[string]interface{}{
        {
            "id":       s.config.Model.Name,
            "object":   "model",
            "created":  time.Now().Unix(),
            "owned_by": "mymodel",
        },
        {
            "id":       "MoM",
            "object":   "model",
            "created":  time.Now().Unix(),
            "owned_by": "mymodel",
        },
    }

    // Add all real models from routes
    for _, route := range s.config.TextRoutes {
        models = append(models, map[string]interface{}{
            "id":       route.Model,
            "object":   "model",
            "created":  time.Now().Unix(),
            "owned_by": route.Provider,
        })
    }

    json.NewEncoder(w).Encode(map[string]interface{}{
        "object": "list",
        "data":   models,
    })
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("ok"))
}

func (s *Server) handleRoutingTest(w http.ResponseWriter, r *http.Request) {
    body, _ := io.ReadAll(r.Body)
    defer r.Body.Close()

    var req ChatCompletionRequest
    json.Unmarshal(body, &req)

    target := s.router.Route(&req)
    json.NewEncoder(w).Encode(target)
}

// --- Helper types and functions ---

type ChatCompletionRequest struct {
    Model    string          `json:"model"`
    Messages []Message       `json:"messages"`
    Stream   *bool           `json:"stream,omitempty"`
    // Pass through all other fields
}

type Message struct {
    Role    string      `json:"role"`
    Content interface{} `json:"content"` // string or []ContentPart
}

type RoutingTarget struct {
    Provider    string   `json:"provider"`
    Model       string   `json:"model"`
    Reason      string   `json:"reason"`
    Signals     []string `json:"signals"`
    Modality    string   `json:"modality"`
    Blocked     bool     `json:"blocked"`
    BlockReason string   `json:"block_reason,omitempty"`
    CacheHit    bool     `json:"cache_hit"`
}

func replaceModelInBody(body []byte, newModel string) []byte {
    var parsed map[string]interface{}
    json.Unmarshal(body, &parsed)
    parsed["model"] = newModel
    result, _ := json.Marshal(parsed)
    return result
}

func writeError(w http.ResponseWriter, msg string, status int) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(map[string]interface{}{
        "error": map[string]interface{}{
            "message": msg,
            "type":    "error",
        },
    })
}

func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "*")
        w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
        if r.Method == "OPTIONS" {
            w.WriteHeader(http.StatusOK)
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

### 3.3 `src/semantic-router/pkg/proxy/modality.go` — Modality detection

```go
package proxy

import (
    "encoding/json"
)

type Modality string

const (
    ModalityText       Modality = "text"
    ModalityImage      Modality = "image"
    ModalityAudio      Modality = "audio"
    ModalityMultimodal Modality = "multimodal"
)

// DetectModality analyzes the OpenAI request payload to determine input type
func DetectModality(req *ChatCompletionRequest) Modality {
    hasImage := false
    hasAudio := false
    hasText := false

    for _, msg := range req.Messages {
        if msg.Role != "user" {
            continue
        }

        switch content := msg.Content.(type) {
        case string:
            hasText = true
        case []interface{}:
            for _, part := range content {
                partMap, ok := part.(map[string]interface{})
                if !ok {
                    continue
                }
                switch partMap["type"] {
                case "text":
                    hasText = true
                case "image_url":
                    hasImage = true
                case "input_audio":
                    hasAudio = true
                }
            }
        default:
            // Try to marshal/unmarshal to check
            raw, _ := json.Marshal(content)
            var s string
            if json.Unmarshal(raw, &s) == nil {
                hasText = true
            }
        }
    }

    if (hasImage && hasAudio) || (hasText && hasImage) || (hasText && hasAudio) {
        return ModalityMultimodal
    }
    if hasAudio {
        return ModalityAudio
    }
    if hasImage {
        return ModalityImage
    }
    return ModalityText
}
```

### 3.4 `src/semantic-router/pkg/routing/router.go` — Connects existing SR logic to our proxy

This is the BRIDGE between the existing vLLM SR code and our new HTTP server.

```go
package routing

import (
    "github.com/massaindustries/mymodel/src/semantic-router/pkg/classification"
    "github.com/massaindustries/mymodel/src/semantic-router/pkg/config"
    "github.com/massaindustries/mymodel/src/semantic-router/pkg/decision"
    "github.com/massaindustries/mymodel/src/semantic-router/pkg/proxy"
)

type Router struct {
    config     *config.RouterConfig
    classifier *classification.Classifier
    decisionEn *decision.Engine
}

func NewRouter(cfg *config.RouterConfig) (*Router, error) {
    // Initialize classifier (loads candle-binding models)
    clf, err := classification.NewClassifier(cfg)
    if err != nil {
        return nil, err
    }

    // Initialize decision engine
    eng := decision.NewEngine(cfg)

    return &Router{
        config:     cfg,
        classifier: clf,
        decisionEn: eng,
    }, nil
}

// Route runs the full pipeline: modality → signals → plugins → decision
func (r *Router) Route(req *proxy.ChatCompletionRequest) proxy.RoutingTarget {
    // Step 1: Modality detection
    modality := proxy.DetectModality(req)

    // Step 2: Non-text modalities → direct route
    if modality != proxy.ModalityText {
        return r.routeByModality(modality)
    }

    // Step 3: Extract text from last user message
    query := extractLastUserText(req)
    if query == "" {
        return r.defaultTarget()
    }

    // Step 4: Use EXISTING vLLM SR classification pipeline
    // This calls candle-binding → BERT/LoRA → signals
    signals := r.classifier.EvaluateAllSignals(query)

    // Step 5: Use EXISTING vLLM SR decision engine
    // This does AND/OR + priority matching
    selectedDecision := r.decisionEn.Evaluate(signals)

    // Step 6: Check plugins (PII, jailbreak) — EXISTING code
    if r.config.Plugins.JailbreakGuard.Enabled {
        if jb := r.classifier.DetectJailbreak(query); jb.IsJailbreak {
            return proxy.RoutingTarget{
                Blocked:     true,
                BlockReason: "Jailbreak attempt detected",
                Modality:    string(modality),
            }
        }
    }

    if r.config.Plugins.PIIDetection.Enabled {
        if pii := r.classifier.DetectPII(query); pii.HasPII {
            if r.config.Plugins.PIIDetection.Action == "block" {
                return proxy.RoutingTarget{
                    Blocked:     true,
                    BlockReason: "PII detected",
                    Modality:    string(modality),
                }
            }
            // TODO: redact PII from query
        }
    }

    // Step 7: Build target from decision
    return proxy.RoutingTarget{
        Provider: selectedDecision.Provider,
        Model:    selectedDecision.Model,
        Reason:   selectedDecision.Reason,
        Signals:  selectedDecision.MatchedSignals,
        Modality: string(modality),
    }
}

func (r *Router) FindModel(modelName string) proxy.RoutingTarget {
    // Look up model in routes
    for _, route := range r.config.TextRoutes {
        if route.Model == modelName {
            return proxy.RoutingTarget{
                Provider: route.Provider,
                Model:    route.Model,
                Reason:   "direct model selection",
                Modality: "text",
            }
        }
    }
    // Fallback: use first provider
    return r.defaultTarget()
}

func (r *Router) routeByModality(mod proxy.Modality) proxy.RoutingTarget {
    switch mod {
    case proxy.ModalityAudio:
        if route := r.config.ModalityRoutes.Audio; route != nil {
            return proxy.RoutingTarget{
                Provider: route.Provider,
                Model:    route.Model,
                Reason:   "audio modality",
                Modality: string(mod),
            }
        }
    case proxy.ModalityImage:
        if route := r.config.ModalityRoutes.Image; route != nil {
            return proxy.RoutingTarget{
                Provider: route.Provider,
                Model:    route.Model,
                Reason:   "image modality",
                Modality: string(mod),
            }
        }
    case proxy.ModalityMultimodal:
        if route := r.config.ModalityRoutes.Multimodal; route != nil {
            return proxy.RoutingTarget{
                Provider: route.Provider,
                Model:    route.Model,
                Reason:   "multimodal",
                Modality: string(mod),
            }
        }
    }
    return r.defaultTarget()
}

func (r *Router) defaultTarget() proxy.RoutingTarget {
    def := r.config.DefaultRoute()
    return proxy.RoutingTarget{
        Provider: def.Provider,
        Model:    def.Model,
        Reason:   "default",
        Modality: "text",
    }
}

func extractLastUserText(req *proxy.ChatCompletionRequest) string {
    for i := len(req.Messages) - 1; i >= 0; i-- {
        if req.Messages[i].Role == "user" {
            if text, ok := req.Messages[i].Content.(string); ok {
                return text
            }
        }
    }
    return ""
}
```

---

## STEP 4: EXTEND CONFIG FOR PROVIDERS AND MODALITY

Modify `src/semantic-router/pkg/config/config.go` — ADD these structs (don't remove existing ones):

```go
// ADD to existing config structs

// ModelConfig — the virtual model identity
type ModelConfig struct {
    Name        string `yaml:"name"`
    Description string `yaml:"description"`
}

// ProviderConfig — backend LLM provider
type ProviderConfig struct {
    Type    string `yaml:"type"`     // "openai-compatible" | "anthropic"
    BaseURL string `yaml:"base_url"`
    APIKey  string `yaml:"api_key"`  // supports ${ENV_VAR}
}

// ModalityRoutesConfig — non-text routing
type ModalityRoutesConfig struct {
    Audio      *ModalityRoute `yaml:"audio"`
    Image      *ModalityRoute `yaml:"image"`
    Multimodal *ModalityRoute `yaml:"multimodal"`
}

type ModalityRoute struct {
    Provider string `yaml:"provider"`
    Model    string `yaml:"model"`
}

// TextRoute — semantic routing rule
type TextRoute struct {
    Name     string       `yaml:"name"`
    Priority int          `yaml:"priority"`
    Signals  SignalConfig `yaml:"signals"`
    Operator string       `yaml:"operator"` // AND | OR
    Provider string       `yaml:"provider"`
    Model    string       `yaml:"model"`
}

// ADD these fields to the main RouterConfig struct:
// Model          ModelConfig                    `yaml:"model"`
// Providers      map[string]*ProviderConfig     `yaml:"providers"`
// ModalityRoutes ModalityRoutesConfig           `yaml:"modality_routes"`
// TextRoutes     []TextRoute                    `yaml:"text_routes"`
// ServerPort     int                            `yaml:"server_port"`

// GetProvider returns a provider config by key
func (c *RouterConfig) GetProvider(key string) *ProviderConfig {
    return c.Providers[key]
}

// DefaultRoute returns the lowest-priority text route
func (c *RouterConfig) DefaultRoute() TextRoute {
    if len(c.TextRoutes) == 0 {
        return TextRoute{Model: "default", Provider: "default"}
    }
    lowest := c.TextRoutes[0]
    for _, r := range c.TextRoutes {
        if r.Priority < lowest.Priority {
            lowest = r
        }
    }
    return lowest
}
```

Also add environment variable resolution in the config loader:

```go
// ADD to config loading
func resolveEnvVars(s string) string {
    re := regexp.MustCompile(`\$\{([^}]+)\}`)
    return re.ReplaceAllStringFunc(s, func(match string) string {
        varName := match[2 : len(match)-1]
        return os.Getenv(varName)
    })
}
```

---

## STEP 5: REWRITE MAIN ENTRY POINT

Replace `src/semantic-router/cmd/main.go`:

```go
package main

import (
    "flag"
    "log"

    "github.com/massaindustries/mymodel/src/semantic-router/pkg/config"
    "github.com/massaindustries/mymodel/src/semantic-router/pkg/proxy"
    "github.com/massaindustries/mymodel/src/semantic-router/pkg/routing"
)

func main() {
    configPath := flag.String("config", "config/config.yaml", "Path to config file")
    port := flag.Int("port", 8000, "Server port")
    flag.Parse()

    // Load config
    cfg, err := config.LoadConfig(*configPath)
    if err != nil {
        log.Fatalf("Failed to load config: %v", err)
    }

    // Initialize router (loads ML models via candle-binding)
    log.Println("Loading classification models...")
    router, err := routing.NewRouter(cfg)
    if err != nil {
        log.Fatalf("Failed to initialize router: %v", err)
    }
    log.Println("Models loaded successfully")

    // Start HTTP server (replaces Envoy)
    server := proxy.NewServer(cfg, router, *port)
    log.Fatal(server.Start())
}
```

---

## STEP 6: SIMPLIFY DOCKER COMPOSE

Replace `deploy/docker-compose/docker-compose.yml`:

```yaml
version: "3.8"

services:
  mymodel:
    build:
      context: ../..
      dockerfile: Dockerfile
    ports:
      - "8000:8000"    # OpenAI-compatible API
      - "8700:8700"    # Dashboard (optional)
    volumes:
      - ../../config:/app/config
    environment:
      - REGOLO_API_KEY=${REGOLO_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - HF_TOKEN=${HF_TOKEN}
    # NO Envoy container needed!
```

---

## STEP 7: SIMPLIFY DOCKERFILE

```dockerfile
# Stage 1: Build Rust candle-binding
FROM rust:1.84-bookworm AS rust-builder
WORKDIR /app
COPY candle-binding/ candle-binding/
RUN cd candle-binding && cargo build --release

# Stage 2: Build Go binary
FROM golang:1.23-bookworm AS go-builder
WORKDIR /app
COPY --from=rust-builder /app/candle-binding/target/release/libcandle_semantic_router.so /usr/lib/
COPY . .
ENV CGO_ENABLED=1
ENV LD_LIBRARY_PATH=/usr/lib
RUN cd src/semantic-router && go build -o /mymodel ./cmd/main.go

# Stage 3: Runtime
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=rust-builder /app/candle-binding/target/release/libcandle_semantic_router.so /usr/lib/
COPY --from=go-builder /mymodel /usr/local/bin/mymodel
COPY config/config.yaml /app/config/config.yaml

EXPOSE 8000 8700
CMD ["mymodel", "--config", "/app/config/config.yaml"]
```

---

## STEP 8: UPDATE CONFIG.YAML

Extend `config/config.yaml` with MyModel-specific sections:

```yaml
# === MyModel sections (NEW) ===

model:
  name: "MyModel"
  description: "Intelligent multimodal LLM gateway"

server_port: 8000

providers:
  regolo:
    type: openai-compatible
    base_url: "https://api.regolo.ai/v1"
    api_key: "${REGOLO_API_KEY}"
  openai:
    type: openai-compatible
    base_url: "https://api.openai.com/v1"
    api_key: "${OPENAI_API_KEY}"

modality_routes:
  audio:
    provider: regolo
    model: whisper-large-v3
  image:
    provider: regolo
    model: llava-next-72b
  multimodal:
    provider: openai
    model: gpt-4o

text_routes:
  - name: coding
    priority: 90
    signals:
      keywords: ["code", "function", "debug", "script"]
      domains: ["computer_science"]
    operator: OR
    provider: regolo
    model: qwen3-coder
  - name: default
    priority: 0
    provider: regolo
    model: llama-3.1-70b

# === Existing vLLM SR sections (KEEP as-is) ===
# signals, decisions, plugins, classifier, cache...
# These still work — the routing.Router calls them internally
```

---

## EXECUTION ORDER FOR CLAUDE CODE

```
1.  Fork the repo, rename module in go.mod
2.  Delete Envoy files (Step 2)
3.  Create src/semantic-router/pkg/proxy/server.go (Step 3.2)
4.  Create src/semantic-router/pkg/proxy/modality.go (Step 3.3)
5.  Create src/semantic-router/pkg/routing/router.go (Step 3.4)
6.  Extend config.go with provider/modality structs (Step 4)
7.  Rewrite cmd/main.go (Step 5)
8.  Update docker-compose.yml (Step 6)
9.  Update Dockerfile (Step 7)
10. Update config.yaml (Step 8)
11. Fix all import paths (old module → new module)
12. Remove ExtProc gRPC server startup from existing code
13. `go mod tidy` to clean dependencies
14. Build candle-binding: `cd candle-binding && cargo build --release`
15. Build Go: `cd src/semantic-router && go build ./cmd/main.go`
16. Test: `curl http://localhost:8000/v1/models`
17. Test: `curl -X POST http://localhost:8000/v1/chat/completions ...`
```

## CRITICAL NOTES FOR CLAUDE CODE

- **The Go code in `pkg/extproc/` already has ALL the classification logic.** The files `req_filter_classification.go`, `req_filter_jailbreak.go`, `req_filter_pii.go` contain the actual pipeline. The new `routing/router.go` just needs to CALL these existing functions instead of them being called by the ExtProc gRPC handler.

- **Do NOT rewrite the signal/decision/plugin logic.** It's already done in the existing codebase. The job is to wire it to an HTTP handler instead of a gRPC ExtProc handler.

- **The `router.go` in `pkg/extproc/` currently implements `ExternalProcessorServer` (gRPC interface).** The key change is: instead of implementing that gRPC interface, we implement `http.HandlerFunc` in our new proxy package, and call the SAME classification/decision functions.

- **candle-binding compilation is required first.** The Go code links against `libcandle_semantic_router.so` via CGO. Without building the Rust library first, Go won't compile.

- **The config.yaml is additive.** Keep ALL existing vLLM SR config sections (signals, decisions, plugins, cache, backend_models). Add our new sections (model, providers, modality_routes, text_routes) alongside them. The existing code reads the existing sections; our new code reads the new sections.

- **SSE streaming pass-through is critical.** The proxy MUST NOT buffer the entire response — it must flush each chunk immediately. The `proxyStreaming` function handles this.

- **Environment variable resolution in config** (`${REGOLO_API_KEY}`) must work. Add the `resolveEnvVars` function to the config loader.