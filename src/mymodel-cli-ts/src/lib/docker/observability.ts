/**
 * Observability stack — Jaeger, Prometheus, Grafana container management.
 * Ported from Python docker_cli.py
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {execaSync} from 'execa'
import {getContainerRuntime} from './runtime.js'
import {removeContainer, stopContainer} from './containers.js'
import {DOCKER_NETWORK, JAEGER_PORT, PROMETHEUS_PORT, GRAFANA_PORT} from '../constants.js'

const JAEGER_CONTAINER = 'vllm-sr-jaeger'
const PROMETHEUS_CONTAINER = 'vllm-sr-prometheus'
const GRAFANA_CONTAINER = 'vllm-sr-grafana'

export const OBSERVABILITY_CONTAINERS = [GRAFANA_CONTAINER, PROMETHEUS_CONTAINER, JAEGER_CONTAINER]

/**
 * Start Jaeger container for distributed tracing.
 */
export function startJaeger(networkName = DOCKER_NETWORK): boolean {
  const runtime = getContainerRuntime()
  try {
    execaSync(runtime, [
      'run', '-d',
      '--name', JAEGER_CONTAINER,
      '--network', networkName,
      '-e', 'COLLECTOR_OTLP_ENABLED=true',
      '-p', '4318:4317',
      '-p', `${JAEGER_PORT}:${JAEGER_PORT}`,
      'jaegertracing/all-in-one:latest',
    ])
    return true
  } catch {
    return false
  }
}

/**
 * Start Prometheus container for metrics collection.
 */
export function startPrometheus(networkName = DOCKER_NETWORK, configDir?: string): boolean {
  const runtime = getContainerRuntime()
  const baseDir = configDir ?? process.cwd()

  // Create dirs
  const promDir = path.join(baseDir, '.vllm-sr', 'prometheus-config')
  const promData = path.join(baseDir, '.vllm-sr', 'prometheus-data', 'data')
  fs.mkdirSync(promDir, {recursive: true})
  fs.mkdirSync(promData, {recursive: true})
  fs.chmodSync(path.join(baseDir, '.vllm-sr', 'prometheus-data'), 0o777)
  fs.chmodSync(promData, 0o777)

  // Copy template
  const templateDir = path.join(import.meta.dirname, '..', '..', '..', 'templates')
  const promConfig = path.join(promDir, 'prometheus.yaml')
  const templateSrc = path.join(templateDir, 'prometheus.serve.yaml')
  if (fs.existsSync(templateSrc)) {
    fs.copyFileSync(templateSrc, promConfig)
  }

  try {
    execaSync(runtime, [
      'run', '-d',
      '--name', PROMETHEUS_CONTAINER,
      '--network', networkName,
      '-v', `${promConfig}:/etc/prometheus/prometheus.yaml:ro`,
      '-v', `${path.dirname(promData)}:/prometheus`,
      '-p', `${PROMETHEUS_PORT}:${PROMETHEUS_PORT}`,
      'prom/prometheus:v2.53.0',
      '--config.file=/etc/prometheus/prometheus.yaml',
      '--storage.tsdb.path=/prometheus/data',
      '--storage.tsdb.retention.time=15d',
    ])
    return true
  } catch {
    return false
  }
}

/**
 * Start Grafana container for visualization.
 */
export function startGrafana(networkName = DOCKER_NETWORK, configDir?: string): boolean {
  const runtime = getContainerRuntime()
  const baseDir = configDir ?? process.cwd()

  // Create dir
  const grafanaDir = path.join(baseDir, '.vllm-sr', 'grafana')
  fs.mkdirSync(grafanaDir, {recursive: true})

  // Copy template files
  const templateDir = path.join(import.meta.dirname, '..', '..', '..', 'templates')
  const templateFiles = [
    'grafana.serve.ini',
    'grafana-datasource.serve.yaml',
    'grafana-datasource-jaeger.serve.yaml',
    'grafana-dashboard.serve.yaml',
    'llm-router-dashboard.serve.json',
  ]
  for (const file of templateFiles) {
    const src = path.join(templateDir, file)
    const dst = path.join(grafanaDir, file)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst)
    }
  }

  const ini = path.join(grafanaDir, 'grafana.serve.ini')
  const datasource = path.join(grafanaDir, 'grafana-datasource.serve.yaml')
  const datasourceJaeger = path.join(grafanaDir, 'grafana-datasource-jaeger.serve.yaml')
  const dashboard = path.join(grafanaDir, 'grafana-dashboard.serve.yaml')
  const dashboardJson = path.join(grafanaDir, 'llm-router-dashboard.serve.json')

  try {
    execaSync(runtime, [
      'run', '-d',
      '--name', GRAFANA_CONTAINER,
      '--network', networkName,
      '-e', 'GF_SECURITY_ADMIN_USER=admin',
      '-e', 'GF_SECURITY_ADMIN_PASSWORD=admin',
      '-e', `PROMETHEUS_URL=${PROMETHEUS_CONTAINER}:${PROMETHEUS_PORT}`,
      '-v', `${ini}:/etc/grafana/grafana.ini:ro`,
      '-v', `${datasource}:/etc/grafana/provisioning/datasources/datasource.yaml:ro`,
      '-v', `${datasourceJaeger}:/etc/grafana/provisioning/datasources/datasource_jaeger.yaml:ro`,
      '-v', `${dashboard}:/etc/grafana/provisioning/dashboards/dashboard.yaml:ro`,
      '-v', `${dashboardJson}:/etc/grafana/provisioning/dashboards/llm-router-dashboard.json:ro`,
      '-p', `${GRAFANA_PORT}:${GRAFANA_PORT}`,
      'grafana/grafana:11.5.1',
    ])
    return true
  } catch {
    return false
  }
}

/**
 * Stop and remove all observability containers.
 */
export function stopObservability(): void {
  for (const name of OBSERVABILITY_CONTAINERS) {
    stopContainer(name)
    removeContainer(name)
  }
}

/**
 * Get observability env vars for the main container.
 */
export function getObservabilityEnvVars(): Record<string, string> {
  return {
    TARGET_JAEGER_URL: `http://${JAEGER_CONTAINER}:${JAEGER_PORT}`,
    TARGET_GRAFANA_URL: `http://${GRAFANA_CONTAINER}:${GRAFANA_PORT}`,
    TARGET_PROMETHEUS_URL: `http://${PROMETHEUS_CONTAINER}:${PROMETHEUS_PORT}`,
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://${JAEGER_CONTAINER}:4317`,
  }
}
