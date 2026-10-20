package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	systemone "github.com/regolo-ai/brick-SR1/systemone"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"gopkg.in/yaml.v2"

	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/brickrouting"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/config"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/logo"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/observability/logging"
	"github.com/regolo-ai/brick-SR1/apps/router/src/spatial-router/pkg/proxy"
)

var version = "development"

func main() {
	defaultConfigPath := strings.TrimSpace(os.Getenv("BRICK_CONFIG_PATH"))
	if defaultConfigPath == "" {
		defaultConfigPath = "config/config.yaml"
	}
	var (
		configPath   = flag.String("config", defaultConfigPath, "Path to the configuration file")
		port         = flag.Int("port", 8000, "Port to listen on for HTTP proxy")
		metricsPort  = flag.Int("metrics-port", 9190, "Port for Prometheus metrics")
		validateOnly = flag.Bool("validate-config", false, "Validate configuration without starting or contacting providers")
		strictConfig = flag.Bool("strict-config", false, "Reject any deprecated 3.x configuration field instead of warning")
		migratePath  = flag.String("migrate-config", "", "Write a normalized configuration to this path (or - for stdout) and exit")
		modelCheck   = flag.String("check-model", "", "Load local model assets and verify inference, then exit")
		modelDir     = flag.String("model-dir", "", "Absolute directory of installed model assets")
		instanceID   = flag.String("instance-id", "", "Runtime instance identifier")
		profile      = flag.String("profile", "", "Runtime profile name")
		showVersion  = flag.Bool("version", false, "Print runtime version")
		routeTest    = flag.String("route-test", "", "Route a test message and print JSON result, then exit")
		routeCands   = flag.String("route-candidates", "", "Comma-separated model allowlist for --route-test (simulates multimodal passthrough candidate restriction)")
	)
	dataDir := flag.String("data-dir", "", "Persistent profile data directory")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}
	if *modelCheck != "" {
		if err := systemone.Init(*modelCheck); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		result, err := systemone.Classify("Hello.")
		if err != nil || len(result) != 6 {
			fmt.Fprintln(os.Stderr, "model verification failed", err)
			os.Exit(1)
		}
		body, _ := json.Marshal(result)
		fmt.Println(string(body))
		return
	}
	absoluteConfig, err := filepath.Abs(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	*configPath = absoluteConfig

	if _, err := logging.InitLoggerFromEnv(); err != nil {
		fmt.Fprintf(os.Stderr, "failed to initialize logger: %v\n", err)
	}

	if _, err := os.Stat(*configPath); os.IsNotExist(err) {
		logging.Fatalf("Config file not found: %s", *configPath)
	}

	cfg, warnings, err := config.ParseWithOptions(*configPath, config.ParseOptions{Strict: *strictConfig})
	for _, warning := range warnings {
		logging.Warnf("config: %s", warning)
	}
	if err != nil {
		logging.Fatalf("Failed to load config: %v", err)
	}
	if *migratePath != "" {
		migrated, merr := yaml.Marshal(cfg)
		if merr != nil {
			logging.Fatalf("Failed to render migrated config: %v", merr)
		}
		if *migratePath == "-" {
			_, merr = os.Stdout.Write(migrated)
		} else {
			merr = os.WriteFile(*migratePath, migrated, 0o600)
		}
		if merr != nil {
			logging.Fatalf("Failed to write migrated config: %v", merr)
		}
		if *migratePath != "-" {
			logging.Infof("Wrote migrated config to %s", *migratePath)
		}
		return
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

	if *modelDir != "" {
		if !filepath.IsAbs(*modelDir) {
			logging.Fatalf("model-dir must be absolute")
		}
		cfg.SkillRouter.SystemOne.LocalPath = *modelDir
	}
	if cfg.SkillRouter.Enabled && cfg.SkillRouter.SystemOne.LocalPath == "" {
		logging.Fatalf("skill_router.systemone.local_path is required unless --model-dir is provided")
	}
	if *validateOnly {
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	startMetricsServer(cfg, *metricsPort)

	if *routeTest != "" {
		runRouteTest(ctx, cfg, *routeTest, *routeCands)
		return
	}

	logo.PrintBrickLogo()
	proxyServer := proxy.NewServer(cfg, *configPath, *port, *dataDir)
	proxyServer.SetRuntimeIdentity(*instanceID, *profile, version)
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
		route, err = router.RouteWithOptions(ctx, message, brickrouting.RoutingOptions{Candidates: allow})
	} else {
		route, err = router.Route(ctx, message)
	}
	if err != nil {
		logging.Fatalf("Route test failed: %v", err)
	}
	body, _ := json.MarshalIndent(route, "", "  ")
	fmt.Println(string(body))
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
		addr := fmt.Sprintf("127.0.0.1:%d", port)
		logging.Infof("Starting metrics server on %s", addr)
		if err := http.ListenAndServe(addr, mux); err != nil {
			logging.Errorf("Metrics server error: %v", err)
		}
	}()
}
