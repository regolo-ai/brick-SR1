package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	candle_binding "github.com/vllm-project/semantic-router/candle-binding"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/apiserver"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/config"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/extproc"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/k8s"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/logo"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/modeldownload"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/observability/logging"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/observability/metrics"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/observability/tracing"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/proxy"
	"github.com/vllm-project/semantic-router/src/semantic-router/pkg/vectorstore"
)

func main() {
	// Display logo
	logo.PrintVLLMLogo()

	// Parse command-line flags
	var (
		configPath            = flag.String("config", "config/config.yaml", "Path to the configuration file")
		port                  = flag.Int("port", 8000, "Port to listen on for HTTP proxy")
		apiPort               = flag.Int("api-port", 8080, "Port to listen on for Classification API")
		metricsPort           = flag.Int("metrics-port", 9190, "Port for Prometheus metrics")
		enableAPI             = flag.Bool("enable-api", true, "Enable Classification API server")
		enableSystemPromptAPI = flag.Bool("enable-system-prompt-api", false, "Enable system prompt configuration endpoints (SECURITY: only enable in trusted environments)")
		kubeconfig            = flag.String("kubeconfig", "", "Path to kubeconfig file (optional, uses in-cluster config if not specified)")
		namespace             = flag.String("namespace", "default", "Kubernetes namespace to watch for CRDs")
		downloadOnly          = flag.Bool("download-only", false, "Download required models and exit (useful for CI/testing)")
		routeTest             = flag.String("route-test", "", "Route a test message and print JSON result, then exit")
	)
	flag.Parse()

	// Initialize logging (zap) from environment.
	if _, err := logging.InitLoggerFromEnv(); err != nil {
		fmt.Fprintf(os.Stderr, "failed to initialize logger: %v\n", err)
	}

	// Check if config file exists
	if _, err := os.Stat(*configPath); os.IsNotExist(err) {
		logging.Fatalf("Config file not found: %s", *configPath)
	}

	// Load configuration
	cfg, err := config.Parse(*configPath)
	if err != nil {
		logging.Fatalf("Failed to load config: %v", err)
	}

	// Resolve environment variables in provider API keys
	cfg.MyModelExtension.ResolveProviderKeys()

	// Validate brick configuration at startup (fail-fast)
	if err := cfg.Brick.Validate(); err != nil {
		logging.Fatalf("Invalid brick configuration: %v", err)
	}


	// Override port from config if not set via flag and config has a value
	if *port == 8000 && cfg.ServerPort > 0 {
		*port = cfg.ServerPort
	}

	// Set the initial configuration in the global config
	config.Replace(cfg)

	// Ensure required models are downloaded
	if modelErr := ensureModelsDownloaded(cfg); modelErr != nil {
		logging.Fatalf("Failed to ensure models are downloaded: %v", modelErr)
	}

	// If download-only mode, exit after downloading models
	if *downloadOnly {
		logging.Infof("Download-only mode: models downloaded successfully, exiting")
		os.Exit(0)
	}

	// Initialize distributed tracing if enabled
	ctx := context.Background()
	if cfg.Observability.Tracing.Enabled {
		tracingCfg := tracing.TracingConfig{
			Enabled:               cfg.Observability.Tracing.Enabled,
			Provider:              cfg.Observability.Tracing.Provider,
			ExporterType:          cfg.Observability.Tracing.Exporter.Type,
			ExporterEndpoint:      cfg.Observability.Tracing.Exporter.Endpoint,
			ExporterInsecure:      cfg.Observability.Tracing.Exporter.Insecure,
			SamplingType:          cfg.Observability.Tracing.Sampling.Type,
			SamplingRate:          cfg.Observability.Tracing.Sampling.Rate,
			ServiceName:           cfg.Observability.Tracing.Resource.ServiceName,
			ServiceVersion:        cfg.Observability.Tracing.Resource.ServiceVersion,
			DeploymentEnvironment: cfg.Observability.Tracing.Resource.DeploymentEnvironment,
		}
		if tracingErr := tracing.InitTracing(ctx, tracingCfg); tracingErr != nil {
			logging.Warnf("Failed to initialize tracing: %v", tracingErr)
		}

		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if shutdownErr := tracing.ShutdownTracing(shutdownCtx); shutdownErr != nil {
				logging.Errorf("Failed to shutdown tracing: %v", shutdownErr)
			}
		}()
	}

	// Initialize windowed metrics if enabled
	if cfg.Observability.Metrics.WindowedMetrics.Enabled {
		logging.Infof("Initializing windowed metrics for load balancing...")
		if initErr := metrics.InitializeWindowedMetrics(cfg.Observability.Metrics.WindowedMetrics); initErr != nil {
			logging.Warnf("Failed to initialize windowed metrics: %v", initErr)
		} else {
			logging.Infof("Windowed metrics initialized successfully")
		}
	}

	// Shutdown hooks for components initialized later
	var shutdownHooks []func()

	// Start metrics server if enabled
	metricsEnabled := true
	if cfg.Observability.Metrics.Enabled != nil {
		metricsEnabled = *cfg.Observability.Metrics.Enabled
	}
	if *metricsPort <= 0 {
		metricsEnabled = false
	}
	if metricsEnabled {
		go func() {
			metricsMux := http.NewServeMux()
			metricsMux.Handle("/metrics", promhttp.Handler())
			metricsAddr := fmt.Sprintf(":%d", *metricsPort)
			logging.Infof("Starting metrics server on %s", metricsAddr)
			if metricsErr := http.ListenAndServe(metricsAddr, metricsMux); metricsErr != nil {
				logging.Errorf("Metrics server error: %v", metricsErr)
			}
		}()
	} else {
		logging.Infof("Metrics server disabled")
	}

	// Initialize embedding models
	embeddingModelsInitialized := initializeEmbeddingModels(cfg)

	// Initialize BERT model if semantic cache is configured to use it
	initBertForSemanticCache(cfg)

	// Initialize vector store if configured
	if cfg.VectorStore != nil && cfg.VectorStore.Enabled {
		initVectorStore(cfg, &shutdownHooks)
	}

	// Initialize modality classifier if modality_detector is enabled
	if md := &cfg.ModalityDetector; md.Enabled {
		method := md.GetMethod()
		if (method == config.ModalityDetectionClassifier || method == config.ModalityDetectionHybrid) &&
			md.Classifier != nil && md.Classifier.ModelPath != "" {
			modelPath := config.ResolveModelPath(md.Classifier.ModelPath)
			logging.Infof("Initializing modality classifier (method=%s) from model: %s", method, modelPath)
			if initErr := extproc.InitModalityClassifier(modelPath, md.Classifier.UseCPU); initErr != nil {
				if method == config.ModalityDetectionClassifier {
					logging.Fatalf("Failed to initialize modality classifier (required for method=%q): %v", method, initErr)
				}
				logging.Warnf("Failed to initialize modality classifier (hybrid will fall back to keywords): %v", initErr)
			} else {
				logging.Infof("Modality classifier initialized successfully")
			}
		}
	}

	// Create the OpenAI router (semantic routing pipeline)
	router, err := extproc.NewOpenAIRouter(*configPath)
	if err != nil {
		logging.Fatalf("Failed to create router: %v", err)
	}

	logging.Infof("MyModel semantic router initialized with config: %s", *configPath)

	// Load tools database after router initialization
	if embeddingModelsInitialized {
		logging.Infof("Loading tools database (embedding models are ready)...")
		if err := router.LoadToolsDatabase(); err != nil {
			logging.Warnf("Failed to load tools database: %v", err)
		}
	} else {
		logging.Infof("Skipping tools database loading (embedding models not initialized)")
	}

	// Handle route-test mode
	if *routeTest != "" {
		runRouteTest(router, *routeTest)
		return
	}

	// Create and start the HTTP proxy server
	proxyServer := proxy.NewServer(router, *configPath, *port)

	// Start API server if enabled
	if *enableAPI {
		go func() {
			logging.Infof("Starting API server on port %d", *apiPort)
			if err := apiserver.Init(*configPath, *apiPort, *enableSystemPromptAPI); err != nil {
				logging.Errorf("Start API server error: %v", err)
			}
		}()
	}

	// Start Kubernetes controller if ConfigSource is kubernetes
	if cfg.ConfigSource == config.ConfigSourceKubernetes {
		logging.Infof("ConfigSource is kubernetes, starting Kubernetes controller")
		go startKubernetesController(cfg, *kubeconfig, *namespace)
	} else {
		logging.Infof("ConfigSource is file (or not specified), using file-based configuration")
	}

	// Set up graceful shutdown
	serverCtx, serverCancel := context.WithCancel(ctx)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-sigChan
		logging.Infof("Received shutdown signal, cleaning up...")
		for _, hook := range shutdownHooks {
			hook()
		}
		serverCancel()
	}()

	// Start the HTTP proxy (blocks until shutdown)
	if err := proxyServer.Start(serverCtx); err != nil {
		logging.Fatalf("Proxy server error: %v", err)
	}
}

// runRouteTest routes a synthetic request and prints the routing decision as JSON.
func runRouteTest(router *extproc.OpenAIRouter, message string) {
	logging.Infof("Route test mode: routing message %q", message)

	fmt.Printf("Route test: message=%q\n", message)
	fmt.Printf("  Config auto models: %v\n", router.Config.GetAutoModelNames())
	fmt.Printf("  Decisions: %d configured\n", len(router.Config.Decisions))
	if router.Config.BackendModels.ModelConfig != nil {
		fmt.Printf("  Backend models: %d configured\n", len(router.Config.BackendModels.ModelConfig))
	}
	fmt.Printf("Route test complete. Use the /v1/routing/test HTTP endpoint for full pipeline testing.\n")
}

// initializeEmbeddingModels initializes all embedding models from config.
// Returns true if at least one model was successfully initialized.
func initializeEmbeddingModels(cfg *config.RouterConfig) bool {
	var embeddingModelsInitialized bool

	qwen3Path := config.ResolveModelPath(cfg.Qwen3ModelPath)
	gemmaPath := config.ResolveModelPath(cfg.GemmaModelPath)
	mmBertPath := config.ResolveModelPath(cfg.EmbeddingModels.MmBertModelPath)
	bertPath := config.ResolveModelPath(cfg.EmbeddingModels.BertModelPath)

	hasUnifiedModels := qwen3Path != "" || gemmaPath != "" || mmBertPath != ""
	hasBertModel := bertPath != ""

	if hasUnifiedModels || hasBertModel {
		logging.Infof("Initializing embedding models: qwen3=%q, gemma=%q, mmbert=%q, bert=%q, useCPU=%t",
			qwen3Path, gemmaPath, mmBertPath, bertPath, cfg.EmbeddingModels.UseCPU)

		if hasUnifiedModels {
			var initErr error

			semanticCacheNeedsBatched := cfg.SemanticCache.Enabled &&
				strings.ToLower(strings.TrimSpace(cfg.SemanticCache.EmbeddingModel)) == "qwen3" &&
				qwen3Path != ""

			mlSelectionNeedsBatched := cfg.ModelSelection.Enabled &&
				cfg.ModelSelection.ML.ModelsPath != "" &&
				cfg.Qwen3ModelPath != ""

			useBatchedInit := semanticCacheNeedsBatched || mlSelectionNeedsBatched

			if useBatchedInit {
				maxBatchSize := 64
				maxWaitMs := uint64(10)
				initErr = candle_binding.InitEmbeddingModelsBatched(
					qwen3Path, maxBatchSize, maxWaitMs, cfg.EmbeddingModels.UseCPU,
				)
				if initErr == nil {
					logging.Infof("Batched embedding model initialized successfully")
					initErr = candle_binding.InitEmbeddingModels(
						qwen3Path, gemmaPath, mmBertPath, cfg.EmbeddingModels.UseCPU,
					)
				}
			} else {
				initErr = candle_binding.InitEmbeddingModels(
					qwen3Path, gemmaPath, mmBertPath, cfg.EmbeddingModels.UseCPU,
				)
			}

			if initErr != nil {
				logging.Errorf("Failed to initialize unified embedding models: %v", initErr)
				logging.Warnf("Tools database will NOT be loaded (requires embedding models)")
			} else {
				logging.Infof("Unified embedding models initialized successfully")
				embeddingModelsInitialized = true
			}
		}

		if hasBertModel {
			logging.Infof("Initializing BERT model for memory: %s", bertPath)
			if bertErr := candle_binding.InitModel(bertPath, cfg.EmbeddingModels.UseCPU); bertErr != nil {
				logging.Warnf("Failed to initialize BERT model: %v", bertErr)
			} else {
				logging.Infof("BERT model initialized successfully (384-dim for memory)")
				embeddingModelsInitialized = true
			}
		}
	} else {
		logging.Infof("No embedding models configured, skipping initialization")
	}

	return embeddingModelsInitialized
}

// initBertForSemanticCache initializes BERT if semantic cache uses it.
func initBertForSemanticCache(cfg *config.RouterConfig) {
	if !cfg.SemanticCache.Enabled {
		return
	}

	embeddingModel := strings.ToLower(strings.TrimSpace(cfg.SemanticCache.EmbeddingModel))
	if embeddingModel == "" {
		if cfg.EmbeddingModels.MmBertModelPath != "" {
			embeddingModel = "mmbert"
		} else if cfg.Qwen3ModelPath != "" {
			embeddingModel = "qwen3"
		} else if cfg.GemmaModelPath != "" {
			embeddingModel = "gemma"
		} else {
			embeddingModel = "bert"
		}
	}

	if embeddingModel == "bert" {
		bertModelID := cfg.BertModel.ModelID
		if bertModelID == "" {
			bertModelID = "sentence-transformers/all-MiniLM-L6-v2"
		}
		bertModelID = config.ResolveModelPath(bertModelID)

		logging.Infof("Semantic cache uses BERT embeddings, initializing BERT model: %s", bertModelID)
		if initErr := candle_binding.InitModel(bertModelID, cfg.BertModel.UseCPU); initErr != nil {
			logging.Fatalf("Failed to initialize BERT model for semantic cache: %v", initErr)
		}
		logging.Infof("BERT model initialized successfully for semantic cache")
	}
}

// initVectorStore initializes the vector store if configured.
func initVectorStore(cfg *config.RouterConfig, shutdownHooks *[]func()) {
	logging.Infof("Initializing vector store feature...")

	if validateErr := cfg.VectorStore.Validate(); validateErr != nil {
		logging.Fatalf("Invalid vector store configuration: %v", validateErr)
	}
	cfg.VectorStore.ApplyDefaults()

	if cfg.VectorStore.EmbeddingModel == "bert" && !cfg.SemanticCache.Enabled {
		bertModelID := cfg.BertModel.ModelID
		if bertModelID == "" {
			bertModelID = "sentence-transformers/all-MiniLM-L6-v2"
		}
		bertModelID = config.ResolveModelPath(bertModelID)
		logging.Infof("Vector store uses BERT embeddings, initializing BERT model: %s", bertModelID)
		if initErr := candle_binding.InitModel(bertModelID, cfg.BertModel.UseCPU); initErr != nil {
			logging.Fatalf("Failed to initialize BERT model for vector store: %v", initErr)
		}
	}

	vsFileStore, vsErr := vectorstore.NewFileStore(cfg.VectorStore.FileStorageDir)
	if vsErr != nil {
		logging.Fatalf("Failed to create vector store file store: %v", vsErr)
	}
	apiserver.SetFileStore(vsFileStore)

	var backendCfgs vectorstore.BackendConfigs
	switch cfg.VectorStore.BackendType {
	case "memory":
		maxEntries := 100000
		if cfg.VectorStore.Memory != nil && cfg.VectorStore.Memory.MaxEntriesPerStore > 0 {
			maxEntries = cfg.VectorStore.Memory.MaxEntriesPerStore
		}
		backendCfgs.Memory = vectorstore.MemoryBackendConfig{MaxEntriesPerStore: maxEntries}
	case "milvus":
		backendCfgs.Milvus = vectorstore.MilvusBackendConfig{
			Address: fmt.Sprintf("%s:%d", cfg.VectorStore.Milvus.Connection.Host, cfg.VectorStore.Milvus.Connection.Port),
		}
	case "llama_stack":
		lsCfg := cfg.VectorStore.LlamaStack
		backendCfgs.LlamaStack = vectorstore.LlamaStackBackendConfig{
			Endpoint:              lsCfg.Endpoint,
			AuthToken:             lsCfg.AuthToken,
			EmbeddingModel:        lsCfg.EmbeddingModel,
			EmbeddingDimension:    cfg.VectorStore.EmbeddingDimension,
			RequestTimeoutSeconds: lsCfg.RequestTimeoutSeconds,
		}
	}
	vsBackend, vsErr := vectorstore.NewBackend(cfg.VectorStore.BackendType, backendCfgs)
	if vsErr != nil {
		logging.Fatalf("Failed to create vector store backend: %v", vsErr)
	}

	vsMgr := vectorstore.NewManager(vsBackend, cfg.VectorStore.EmbeddingDimension, cfg.VectorStore.BackendType)
	apiserver.SetVectorStoreManager(vsMgr)

	vsEmbedder := vectorstore.NewCandleEmbedder(cfg.VectorStore.EmbeddingModel, cfg.VectorStore.EmbeddingDimension)
	apiserver.SetEmbedder(vsEmbedder)

	vsPipeline := vectorstore.NewIngestionPipeline(vsBackend, vsFileStore, vsMgr, vsEmbedder, vectorstore.PipelineConfig{
		Workers:   cfg.VectorStore.IngestionWorkers,
		QueueSize: 100,
	})
	vsPipeline.Start()
	apiserver.SetIngestionPipeline(vsPipeline)

	*shutdownHooks = append(*shutdownHooks, func() {
		logging.Infof("Shutting down vector store pipeline...")
		vsPipeline.Stop()
		vsBackend.Close()
	})

	logging.Infof("Vector store initialized: backend=%s, model=%s, dim=%d, workers=%d",
		cfg.VectorStore.BackendType, cfg.VectorStore.EmbeddingModel,
		cfg.VectorStore.EmbeddingDimension, cfg.VectorStore.IngestionWorkers)
}

// ensureModelsDownloaded checks and downloads required models
func ensureModelsDownloaded(cfg *config.RouterConfig) error {
	logging.Infof("Installing required models...")

	specs, err := modeldownload.BuildModelSpecs(cfg)
	if err != nil {
		return fmt.Errorf("failed to build model specs: %w", err)
	}

	if len(specs) == 0 {
		logging.Infof("No local models configured, skipping model download (API-only mode)")
		return nil
	}

	uniqueModels := make(map[string]bool)
	for _, repoID := range cfg.MoMRegistry {
		uniqueModels[repoID] = true
	}

	logging.Infof("MoM Families: %d unique models (total %d registry aliases)", len(uniqueModels), len(cfg.MoMRegistry))

	if err := modeldownload.CheckHuggingFaceCLI(); err != nil {
		return fmt.Errorf("huggingface-cli check failed: %w", err)
	}

	downloadConfig := modeldownload.GetDownloadConfig()

	maskedToken := "***"
	if downloadConfig.HFToken == "" {
		maskedToken = "<not set>"
	}
	logging.Infof("HF_ENDPOINT: %s; HF_TOKEN: %s; HF_HOME: %s", downloadConfig.HFEndpoint, maskedToken, downloadConfig.HFHome)

	if err := modeldownload.EnsureModels(specs, downloadConfig); err != nil {
		return fmt.Errorf("failed to download models: %w", err)
	}

	logging.Infof("All required models are ready")
	return nil
}

// startKubernetesController starts the Kubernetes controller for watching CRDs
func startKubernetesController(staticConfig *config.RouterConfig, kubeconfig, namespace string) {
	logging.Infof("Starting Kubernetes controller for namespace: %s", namespace)

	controller, err := k8s.NewController(k8s.ControllerConfig{
		Namespace:    namespace,
		Kubeconfig:   kubeconfig,
		StaticConfig: staticConfig,
		OnConfigUpdate: func(newConfig *config.RouterConfig) error {
			config.Replace(newConfig)
			logging.Infof("Configuration updated from Kubernetes CRDs")
			return nil
		},
	})
	if err != nil {
		logging.Fatalf("Failed to create Kubernetes controller: %v", err)
	}

	ctx := context.Background()
	if err := controller.Start(ctx); err != nil {
		logging.Fatalf("Kubernetes controller error: %v", err)
	}
}
