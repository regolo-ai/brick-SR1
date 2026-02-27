/**
 * Constants for MyModel CLI — Docker images, ports, timeouts.
 * Ported from Python consts.py
 */

// Docker image configuration
export const DOCKER_IMAGE_DEFAULT = 'ghcr.io/vllm-project/semantic-router/vllm-sr:latest'
export const DOCKER_IMAGE_DEV = 'vllm-sr:dev'
export const DOCKER_IMAGE_RELEASE = 'vllm-sr:0.1.0'
export const DOCKER_CONTAINER_NAME = 'vllm-sr-container'
export const DOCKER_NETWORK = 'vllm-sr-network'

// Image pull policies
export const IMAGE_PULL_ALWAYS = 'always'
export const IMAGE_PULL_IF_NOT_PRESENT = 'ifnotpresent'
export const IMAGE_PULL_NEVER = 'never'
export const DEFAULT_IMAGE_PULL_POLICY = IMAGE_PULL_ALWAYS

// Service names
export const SERVICE_ROUTER = 'router'
export const SERVICE_ENVOY = 'envoy'

// Default ports
export const DEFAULT_PROXY_PORT = 8000
export const DEFAULT_API_PORT = 8080
export const DEFAULT_METRICS_PORT = 9190
export const DEFAULT_ENVOY_PORT = 9901
export const DEFAULT_ROUTER_PORT = 50051
export const DEFAULT_DASHBOARD_PORT = 8700

// Observability ports
export const JAEGER_PORT = 16686
export const PROMETHEUS_PORT = 9090
export const GRAFANA_PORT = 3000

// Health check
export const HEALTH_CHECK_TIMEOUT = 1800 // 5 minutes (model loading can be slow)
export const HEALTH_CHECK_INTERVAL = 2

// File descriptor limits
export const DEFAULT_NOFILE_LIMIT = 65536
export const MIN_NOFILE_LIMIT = 8192

// External API model formats
export const EXTERNAL_API_MODEL_FORMATS = ['anthropic']

// Algorithm types for model selection
export const ALGORITHM_TYPES = [
  'static', 'elo', 'router_dc', 'automix', 'hybrid',
  'thompson', 'gmtrouter', 'router_r1',
] as const

export type AlgorithmType = typeof ALGORITHM_TYPES[number]
