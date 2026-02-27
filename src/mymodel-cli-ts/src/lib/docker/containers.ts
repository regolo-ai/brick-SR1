/**
 * Container lifecycle management — start, stop, status, logs, exec.
 * Ported from Python docker_cli.py
 */

import {execa, execaSync} from 'execa'
import {getContainerRuntime, getHostGatewayArgs} from './runtime.js'
import {
  DOCKER_CONTAINER_NAME,
  DOCKER_IMAGE_DEFAULT,
  DOCKER_NETWORK,
  DEFAULT_NOFILE_LIMIT,
  DEFAULT_API_PORT,
  DEFAULT_METRICS_PORT,
  DEFAULT_DASHBOARD_PORT,
} from '../constants.js'

export type ContainerStatus = 'running' | 'exited' | 'paused' | 'not found' | 'error'

/**
 * Check the status of a Docker container.
 */
export function containerStatus(containerName: string): ContainerStatus {
  const runtime = getContainerRuntime()
  try {
    const {stdout} = execaSync(runtime, [
      'ps', '-a', '--filter', `name=^${containerName}$`, '--format', '{{.Status}}',
    ])
    const status = stdout.trim()
    if (!status) return 'not found'
    if (status.includes('Up')) return 'running'
    if (status.includes('Exited')) return 'exited'
    if (status.includes('Paused')) return 'paused'
    return 'not found'
  } catch {
    return 'error'
  }
}

/**
 * Stop a container.
 */
export function stopContainer(containerName: string): boolean {
  const runtime = getContainerRuntime()
  try {
    execaSync(runtime, ['stop', containerName], {timeout: 15000})
    return true
  } catch {
    return false
  }
}

/**
 * Remove a container.
 */
export function removeContainer(containerName: string): boolean {
  const runtime = getContainerRuntime()
  try {
    execaSync(runtime, ['rm', '-f', containerName])
    return true
  } catch {
    return false
  }
}

/**
 * Get container logs.
 */
export async function containerLogs(
  containerName: string,
  options: {follow?: boolean; tail?: number} = {},
): Promise<string> {
  const runtime = getContainerRuntime()
  const args = ['logs']
  if (options.follow) args.push('-f')
  if (options.tail) args.push('--tail', String(options.tail))
  args.push(containerName)

  const {stdout} = await execa(runtime, args)
  return stdout
}

/**
 * Execute a command inside a running container.
 */
export function containerExec(
  containerName: string,
  command: string[],
): {exitCode: number; stdout: string; stderr: string} {
  const runtime = getContainerRuntime()
  try {
    const result = execaSync(runtime, ['exec', containerName, ...command], {
      reject: false,
    })
    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch {
    return {exitCode: 1, stdout: '', stderr: 'exec failed'}
  }
}

/**
 * Create a Docker network (ignore if exists).
 */
export function createNetwork(networkName: string): boolean {
  const runtime = getContainerRuntime()
  try {
    execaSync(runtime, ['network', 'create', networkName])
    return true
  } catch {
    return false // Already exists
  }
}

/**
 * Remove a Docker network.
 */
export function removeNetwork(networkName: string): boolean {
  const runtime = getContainerRuntime()
  try {
    execaSync(runtime, ['network', 'rm', networkName])
    return true
  } catch {
    return false
  }
}

/**
 * Check if a Docker image exists locally.
 */
export function imageExists(imageName: string): boolean {
  const runtime = getContainerRuntime()
  try {
    const {stdout} = execaSync(runtime, ['images', '-q', imageName])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

/**
 * Pull a Docker image.
 */
export async function pullImage(imageName: string): Promise<boolean> {
  const runtime = getContainerRuntime()
  try {
    await execa(runtime, ['pull', imageName])
    return true
  } catch {
    return false
  }
}

export interface StartContainerOptions {
  configFile: string
  envVars: Record<string, string>
  image?: string
  networkName?: string
  ports: Array<{host: number; container: number}>
  minimal?: boolean
}

/**
 * Start the main vLLM SR container.
 */
export function startMainContainer(options: StartContainerOptions): {
  success: boolean
  containerId?: string
  error?: string
} {
  const runtime = getContainerRuntime()
  const image = options.image ?? process.env.VLLM_SR_IMAGE ?? DOCKER_IMAGE_DEFAULT

  const nofileLimit = Number(process.env.VLLM_SR_NOFILE_LIMIT) || DEFAULT_NOFILE_LIMIT

  const cmd: string[] = [
    'run', '-d',
    '--name', DOCKER_CONTAINER_NAME,
    '--ulimit', `nofile=${nofileLimit}:${nofileLimit}`,
  ]

  // Network
  if (options.networkName) {
    cmd.push('--network', options.networkName)
  }

  // Host gateway
  cmd.push(...getHostGatewayArgs())

  // Port mappings
  for (const port of options.ports) {
    cmd.push('-p', `${port.host}:${port.container}`)
  }

  // Internal ports
  cmd.push('-p', `${DEFAULT_METRICS_PORT}:${DEFAULT_METRICS_PORT}`)
  cmd.push('-p', `${DEFAULT_API_PORT}:${DEFAULT_API_PORT}`)
  if (!options.minimal) {
    cmd.push('-p', `${DEFAULT_DASHBOARD_PORT}:${DEFAULT_DASHBOARD_PORT}`)
  }

  // Volume mounts
  const configAbs = require('node:path').resolve(options.configFile)
  cmd.push('-v', `${configAbs}:/app/config.yaml:z`)

  // Environment variables
  for (const [key, value] of Object.entries(options.envVars)) {
    cmd.push('-e', `${key}=${value}`)
  }

  cmd.push(image)

  try {
    const {stdout} = execaSync(runtime, cmd)
    return {success: true, containerId: stdout.trim()}
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)
    return {success: false, error: msg}
  }
}
