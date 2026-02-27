/**
 * Abstract base command — shared --config flag for all commands.
 */

import {Command, Flags} from '@oclif/core'
import * as p from '@clack/prompts'
import {loadConfig} from './lib/config/loader.js'
import type {MyModelConfig} from './lib/config/schema.js'

export abstract class BaseCommand extends Command {
  static baseFlags = {
    config: Flags.string({
      char: 'c',
      default: 'config.yaml',
      description: 'Path to config file',
      env: 'MYMODEL_CONFIG',
    }),
  }

  protected loadConfigOrExit(configPath: string): MyModelConfig {
    try {
      return loadConfig(configPath)
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        p.log.error(`Config file not found: ${configPath}`)
        p.log.message('Run mymodel init to create a configuration.')
      } else {
        p.log.error(`Error loading config: ${error}`)
      }
      this.exit(1)
    }
  }
}
