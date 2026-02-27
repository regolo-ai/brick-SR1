/**
 * Service orchestration — start/stop/status for vLLM SR.
 * Ported from Python core.py
 */

import * as path from 'node:path'
import {
  containerStatus,
  containerExec,
  stopContainer,
  removeContainer,
  createNetwork,
  removeNetwork,
  startMainContainer,
} from './docker/containers.js'
import {
  startJaeger,
  startPrometheus,
  startGrafana,
  stopObservability,
  getObservabilityEnvVars,
  OBSERVABILITY_CONTAINERS,
} from './docker/observability.js'
import {
  DOCKER_CONTAINER_NAME,
  DOCKER_NETWORK,
  DEFAULT_PROXY_PORT,
  DEFAULT_API_PORT,
  DEFAULT_METRICS_PORT,
  DEFAULT_DASHBOARD_PORT,
  HEALTH_CHECK_TIMEOUT,
  HEALTH_CHECK_INTERVAL,
  JAEGER_PORT,
  PROMETHEUS_PORT,
  GRAFANA_PORT,
} from './constants.js'
import {printOk, printErr, printWarn} from './ui/output.js'
import {ACCENT, SUCCESS, DIM} from './ui/theme.js'
import type {MyModelConfig} from './config/schema.js'

/**
 * Start the vLLM SR service with optional observability stack.
 */
export async function startVllmSr(
  configFile: string,
  config: MyModelConfig,
  options: {
    envVars?: Record<string, string>
    image?: string
    enableObservability?: boolean
    minimal?: boolean
  } = {},
): Promise<void> {
  const envVars: Record<string, string> = {...(options.envVars ?? {})}
  const enableObs = options.enableObservability !== false
  const configDir = path.dirname(path.resolve(configFile))

  // Cleanup existing container
  const status = containerStatus(DOCKER_CONTAINER_NAME)
  if (status !== 'not found') {
    stopContainer(DOCKER_CONTAINER_NAME)
    removeContainer(DOCKER_CONTAINER_NAME)
  }

  // Observability stack
  if (enableObs) {
    createNetwork(DOCKER_NETWORK)

    printOk('Starting Jaeger (tracing)...')
    startJaeger(DOCKER_NETWORK)

    printOk('Starting Prometheus (metrics)...')
    startPrometheus(DOCKER_NETWORK, configDir)

    printOk('Starting Grafana (dashboard)...')
    startGrafana(DOCKER_NETWORK, configDir)

    Object.assign(envVars, getObservabilityEnvVars())
  }

  // Determine ports
  const proxyPort = config.server.port ?? DEFAULT_PROXY_PORT
  const ports = [
    {host: proxyPort, container: proxyPort},
  ]

  // Start main container
  printOk('Starting MyModel router...')
  const result = startMainContainer({
    configFile,
    envVars,
    image: options.image,
    networkName: enableObs ? DOCKER_NETWORK : undefined,
    ports,
    minimal: options.minimal,
  })

  if (!result.success) {
    printErr(`Failed to start container: ${result.error}`)
    return
  }

  // Health check loop
  printOk('Waiting for health check...')
  const startTime = Date.now()
  const timeoutMs = HEALTH_CHECK_TIMEOUT * 1000
  let healthy = false
  let checks = 0

  while (Date.now() - startTime < timeoutMs) {
    checks++

    // Check container still running
    const cStatus = containerStatus(DOCKER_CONTAINER_NAME)
    if (cStatus !== 'running') {
      printErr('Container exited unexpectedly')
      return
    }

    // Check health endpoint
    const exec = containerExec(DOCKER_CONTAINER_NAME, [
      'curl', '-f', '-s', `http://localhost:${DEFAULT_API_PORT}/health`,
    ])

    if (exec.exitCode === 0) {
      healthy = true
      break
    }

    if (checks % 10 === 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      console.log(DIM(`  ... still starting (${elapsed}s elapsed)`))
    }

    await new Promise(resolve => setTimeout(resolve, HEALTH_CHECK_INTERVAL * 1000))
  }

  if (!healthy) {
    printErr('Health check timed out')
    return
  }

  // Print endpoints
  console.log()
  printOk(`Server ready on ${ACCENT(`http://localhost:${proxyPort}`)}`)
  console.log(`  API:       ${ACCENT(`http://localhost:${DEFAULT_API_PORT}`)}`)
  console.log(`  Metrics:   ${ACCENT(`http://localhost:${DEFAULT_METRICS_PORT}/metrics`)}`)

  if (!options.minimal) {
    console.log(`  Dashboard: ${ACCENT(`http://localhost:${DEFAULT_DASHBOARD_PORT}`)}`)
  }

  if (enableObs) {
    console.log(`  Jaeger:    ${ACCENT(`http://localhost:${JAEGER_PORT}`)}`)
    console.log(`  Prometheus:${ACCENT(`http://localhost:${PROMETHEUS_PORT}`)}`)
    console.log(`  Grafana:   ${ACCENT(`http://localhost:${GRAFANA_PORT}`)} (admin/admin)`)
  }
}

/**
 * Stop all vLLM SR services.
 */
export function stopVllmSr(): void {
  stopContainer(DOCKER_CONTAINER_NAME)
  removeContainer(DOCKER_CONTAINER_NAME)
  stopObservability()
  removeNetwork(DOCKER_NETWORK)
}

/**
 * Show status of all services.
 */
export function showServiceStatus(): void {
  const mainStatus = containerStatus(DOCKER_CONTAINER_NAME)
  const statusIcon = mainStatus === 'running' ? SUCCESS('◉') : DIM('○')
  console.log(`  ${statusIcon} Router: ${mainStatus}`)

  if (mainStatus === 'running') {
    // Check health endpoints
    const health = containerExec(DOCKER_CONTAINER_NAME, [
      'curl', '-f', '-s', `http://localhost:${DEFAULT_API_PORT}/health`,
    ])
    console.log(`    Health: ${health.exitCode === 0 ? SUCCESS('healthy') : DIM('unhealthy')}`)
  }

  // Check observability containers
  for (const name of OBSERVABILITY_CONTAINERS) {
    const status = containerStatus(name)
    const icon = status === 'running' ? SUCCESS('◉') : DIM('○')
    const displayName = name.replace('vllm-sr-', '').charAt(0).toUpperCase() +
      name.replace('vllm-sr-', '').slice(1)
    console.log(`  ${icon} ${displayName}: ${status}`)
  }
}
