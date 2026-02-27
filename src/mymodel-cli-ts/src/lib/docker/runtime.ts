/**
 * Container runtime detection — Docker or Podman.
 * Ported from Python docker_cli.py::get_container_runtime()
 */

import {execaSync} from 'execa'

let cachedRuntime: string | null = null

/**
 * Detect the container runtime: docker or podman.
 * Checks CONTAINER_RUNTIME env var first, then auto-detects.
 */
export function getContainerRuntime(): string {
  if (cachedRuntime) return cachedRuntime

  const envRuntime = process.env.CONTAINER_RUNTIME
  if (envRuntime && ['docker', 'podman'].includes(envRuntime.toLowerCase())) {
    cachedRuntime = envRuntime.toLowerCase()
    return cachedRuntime
  }

  // Auto-detect: prefer docker, fallback to podman
  try {
    execaSync('which', ['docker'])
    cachedRuntime = 'docker'
    return cachedRuntime
  } catch {
    // docker not found
  }

  try {
    execaSync('which', ['podman'])
    cachedRuntime = 'podman'
    return cachedRuntime
  } catch {
    // podman not found
  }

  throw new Error(
    'Neither docker nor podman found in PATH.\n' +
    'Install Docker: https://docs.docker.com/get-docker/\n' +
    'Or Podman: https://podman.io/getting-started/',
  )
}

/**
 * Get the host gateway address for container networking.
 * Docker uses --add-host=host.docker.internal:host-gateway.
 * Podman needs explicit IP detection.
 */
export function getHostGatewayArgs(): string[] {
  const runtime = getContainerRuntime()
  if (runtime === 'docker') {
    return ['--add-host=host.docker.internal:host-gateway']
  }

  // Podman: try to detect host IP
  try {
    const {stdout} = execaSync('hostname', ['-I'])
    const hostIp = stdout.trim().split(' ')[0]
    if (hostIp) {
      return [`--add-host=host.docker.internal:${hostIp}`]
    }
  } catch {
    // Podman provides host.containers.internal by default
  }

  return []
}
