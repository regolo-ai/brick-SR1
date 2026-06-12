package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/complexityserver"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/logo"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/modeldownload"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/metrics"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/tracing"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/proxy"
)

func main() {
	logo.PrintBrickLogo()

	var (
		configPath   = flag.String("config", "config/config.yaml", "Path to the configuration file")
		port         = flag.Int("port", 8000, "Port to listen on for HTTP proxy")
		metricsPort  = flag.Int("metrics-port", 9190, "Port for Prometheus metrics")
		downloadOnly = flag.Bool("download-only", false, "Download required models and exit")
		routeTest    = flag.String("route-test", "", "Route a test message and print JSON result, then exit")
		routeCands   = flag.String("route-candidates", "", "Comma-separated model allowlist for --route-test (simulates multimodal passthrough candidate restriction)")
	)
	flag.Parse()

	if _, err := logging.InitLoggerFromEnv(); err != nil {
		fmt.Fprintf(os.Stderr, "failed to initialize logger: %v\n", err)
	}

	if _, err := os.Stat(*configPath); os.IsNotExist(err) {
		logging.Fatalf("Config file not found: %s", *configPath)
	}

	cfg, err := config.Parse(*configPath)
	if err != nil {
		logging.Fatalf("Failed to load config: %v", err)
	}
	cfg.BrickExtension.ResolveProviderKeys()
	if err := cfg.Brick.Validate(); err != nil {
		logging.Fatalf("Invalid brick configuration: %v", err)
	}
	if cfg.SkillRouter.Enabled && !cfg.Brick.Enabled {
		logging.Warnf("skill_router is enabled but brick gateway is disabled")
	}
	if *port == 8000 && cfg.ServerPort > 0 {
		*port = cfg.ServerPort
	}
	config.Replace(cfg)

	if err := ensureModelsDownloaded(cfg); err != nil {
		logging.Fatalf("Failed to ensure models are downloaded: %v", err)
	}
	complexityProc, err := complexityserver.EnsureRunning(cfg.ComplexityService)
	if err != nil {
		logging.Warnf("ComplexityServer auto-spawn failed: %v (router will fall back to medium)", err)
	}
	if complexityProc != nil {
		defer complexityProc.Stop()
	}
	if *downloadOnly {
		logging.Infof("Download-only mode: models downloaded successfully, exiting")
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	initTracing(ctx, cfg)
	startMetricsServer(cfg, *metricsPort)
	initWindowedMetrics(cfg)

	if *routeTest != "" {
		runRouteTest(ctx, cfg, *routeTest, *routeCands)
		return
	}

	proxyServer := proxy.NewServer(cfg, *configPath, *port)
	serverCtx, serverCancel := context.WithCancel(ctx)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigChan
		logging.Infof("Received shutdown signal")
		cancel()
		serverCancel()
	}()

	if err := proxyServer.Start(serverCtx); err != nil {
		logging.Fatalf("Proxy server error: %v", err)
	}
}

func runRouteTest(ctx context.Context, cfg *config.RouterConfig, message, candidates string) {
	router, err := brickrouting.New(cfg)
	if err != nil {
		logging.Fatalf("Failed to create Brick router: %v", err)
	}
	var route *brickrouting.Result
	if strings.TrimSpace(candidates) != "" {
		allow := make(map[string]bool)
		for _, c := range strings.Split(candidates, ",") {
			if c = strings.TrimSpace(c); c != "" {
				allow[c] = true
			}
		}
		route, err = router.RouteWithCandidates(ctx, message, allow)
	} else {
		route, err = router.Route(ctx, message)
	}
	if err != nil {
		logging.Fatalf("Route test failed: %v", err)
	}
	body, _ := json.MarshalIndent(route, "", "  ")
	fmt.Println(string(body))
}

func initTracing(ctx context.Context, cfg *config.RouterConfig) {
	if !cfg.Observability.Tracing.Enabled {
		return
	}
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
	if err := tracing.InitTracing(ctx, tracingCfg); err != nil {
		logging.Warnf("Failed to initialize tracing: %v", err)
		return
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tracing.ShutdownTracing(shutdownCtx); err != nil {
			logging.Errorf("Failed to shutdown tracing: %v", err)
		}
	}()
}

func startMetricsServer(cfg *config.RouterConfig, port int) {
	metricsEnabled := true
	if cfg.Observability.Metrics.Enabled != nil {
		metricsEnabled = *cfg.Observability.Metrics.Enabled
	}
	if port <= 0 {
		metricsEnabled = false
	}
	if !metricsEnabled {
		logging.Infof("Metrics server disabled")
		return
	}
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		addr := fmt.Sprintf(":%d", port)
		logging.Infof("Starting metrics server on %s", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			logging.Errorf("Metrics server error: %v", err)
		}
	}()
}

func initWindowedMetrics(cfg *config.RouterConfig) {
	if !cfg.Observability.Metrics.WindowedMetrics.Enabled {
		return
	}
	if err := metrics.InitializeWindowedMetrics(cfg.Observability.Metrics.WindowedMetrics); err != nil {
		logging.Warnf("Failed to initialize windowed metrics: %v", err)
		return
	}
	logging.Infof("Windowed metrics initialized successfully")
}

func ensureModelsDownloaded(cfg *config.RouterConfig) error {
	logging.Infof("Installing required models...")

	specs, err := modeldownload.BuildModelSpecs(cfg)
	if err != nil {
		return fmt.Errorf("failed to build model specs: %w", err)
	}
	if len(specs) == 0 {
		logging.Infof("No local models configured, skipping model download")
		return nil
	}

	if err := modeldownload.CheckHuggingFaceCLI(); err != nil {
		return fmt.Errorf("huggingface-cli check failed: %w", err)
	}
	if err := modeldownload.EnsureModels(specs, modeldownload.GetDownloadConfig()); err != nil {
		return fmt.Errorf("failed to download models: %w", err)
	}
	logging.Infof("All required models are ready")
	return nil
}
