/**
 * `mymodel serve` — start the MyModel server.
 *
 * Uses @clack/prompts note() instead of boxen for the banner,
 * and log.* for status messages.
 */

import {Flags} from '@oclif/core'
import * as p from '@clack/prompts'
import {BaseCommand} from '../base-command.js'
import {startVllmSr} from '../lib/core.js'
import {ACCENT, ACCENT_BOLD, SUCCESS, DIM} from '../lib/ui/theme.js'
import {ALGORITHM_TYPES} from '../lib/constants.js'
import * as fs from 'node:fs'
import * as yaml from 'js-yaml'
import * as os from 'node:os'
import * as path from 'node:path'

export default class Serve extends BaseCommand {
  static summary = 'Start the MyModel server'

  static flags = {
    ...BaseCommand.baseFlags,
    port: Flags.integer({char: 'p', default: 8000, description: 'Server port'}),
    image: Flags.string({description: 'Docker image to use'}),
    algorithm: Flags.string({
      description: 'Model selection algorithm override',
      options: [...ALGORITHM_TYPES],
    }),
    minimal: Flags.boolean({default: false, description: 'No dashboard or observability'}),
    readonly: Flags.boolean({default: false, description: 'Dashboard read-only mode'}),
  }

  static examples = [
    '<%= config.bin %> serve',
    '<%= config.bin %> serve --port 9000 --minimal',
    '<%= config.bin %> serve --algorithm elo',
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(Serve)

    const config = this.loadConfigOrExit(flags.config)

    // Port override
    if (flags.port && flags.port !== config.server.port) {
      config.server.port = flags.port
    }

    // Algorithm injection
    let effectivePath = flags.config
    if (flags.algorithm) {
      effectivePath = this.injectAlgorithm(flags.config, flags.algorithm)
    }

    // Collect env vars
    const envVars: Record<string, string> = {}
    const envKeys = [
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'REGOLO_API_KEY', 'GOOGLE_API_KEY',
      'HF_ENDPOINT', 'HF_TOKEN', 'HF_HOME', 'HF_HUB_CACHE',
    ]
    for (const key of envKeys) {
      if (process.env[key]) {
        envVars[key] = process.env[key]!
      }
    }

    // Print banner
    this.printBanner(config)

    try {
      await startVllmSr(effectivePath, config, {
        envVars,
        image: flags.image,
        enableObservability: !flags.minimal,
        minimal: flags.minimal,
      })
    } catch (error) {
      if ((error as Error).message?.includes('Neither docker nor podman')) {
        p.log.error('Docker or Podman is required to run the server.')
        p.log.message('Install Docker: https://docs.docker.com/get-docker/')
      } else {
        throw error
      }
    }
  }

  private printBanner(config: typeof import('../lib/config/schema.js').MyModelConfigSchema extends never ? never : import('../lib/config/schema.js').MyModelConfig): void {
    const modelName = config.model.name
    const port = config.server.port

    const lines: string[] = [
      ACCENT_BOLD(`MyModel: ${modelName}`),
      '',
      `  Providers: ${Object.keys(config.providers).length} (${Object.keys(config.providers).join(', ')})`,
      `  Routes:    ${config.text_routes.length}`,
    ]

    const plugins = config.plugins
    const pluginStatus: string[] = []
    for (const [name, conf] of Object.entries(plugins)) {
      const short = name.split('_')[0].toUpperCase()
      pluginStatus.push(conf.enabled ? SUCCESS(`${short} ON`) : DIM(`${short} OFF`))
    }
    if (pluginStatus.length > 0) {
      lines.push(`  Plugins:   ${pluginStatus.join('  ')}`)
    }

    p.note(lines.join('\n'), 'Configuration')

    p.log.success(`Server listening on ${ACCENT_BOLD(`http://0.0.0.0:${port}`)}`)

    p.note(
      [
        `curl http://localhost:${port}/v1/chat/completions \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -d '{"model":"${modelName}","messages":[{"role":"user","content":"hello"}]}'`,
      ].join('\n'),
      'Try it',
    )

    p.log.message('Press Ctrl+C to stop.')
  }

  private injectAlgorithm(configPath: string, algorithm: string): string {
    const raw = yaml.load(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown> ?? {}
    const decisions = raw.decisions as Array<Record<string, unknown>> | undefined
    if (decisions) {
      for (const decision of decisions) {
        if (!decision.algorithm) decision.algorithm = {}
        ;(decision.algorithm as Record<string, unknown>).type = algorithm
      }
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mymodel-'))
    const tmpPath = path.join(tmpDir, 'config-with-algorithm.yaml')
    fs.writeFileSync(tmpPath, yaml.dump(raw, {sortKeys: false}))
    return tmpPath
  }
}
