/**
 * `mymodel config validate` — validate config.yaml against schema.
 *
 * Uses clack spinner and log.* for results.
 */

import * as p from '@clack/prompts'
import {BaseCommand} from '../../base-command.js'
import {validateProvidersInRoutes} from '../../lib/config/loader.js'
import {withSpinner} from '../../lib/ui/spinners.js'
import {ACCENT} from '../../lib/ui/theme.js'

export default class ConfigValidate extends BaseCommand {
  static summary = 'Validate configuration file'
  static description = 'Validate config.yaml against the schema and check provider references.'

  static examples = [
    '<%= config.bin %> config validate',
    '<%= config.bin %> config validate --config ./my-config.yaml',
  ]

  async run(): Promise<void> {
    const {flags} = await this.parse(ConfigValidate)

    const config = await withSpinner('Validating configuration...', async () => {
      return this.loadConfigOrExit(flags.config)
    }, 'Validation complete')

    const errors: string[] = []

    // Check providers in routes
    errors.push(...validateProvidersInRoutes(config))

    // Check we have at least one provider
    if (Object.keys(config.providers).length === 0) {
      errors.push('No providers configured')
    }

    // Check env vars are resolvable
    const envVarRe = /\$\{([^}]+)\}/g
    for (const [pname, prov] of Object.entries(config.providers)) {
      if (prov.api_key) {
        let match: RegExpExecArray | null
        while ((match = envVarRe.exec(prov.api_key)) !== null) {
          const varName = match[1]
          if (!(varName in process.env)) {
            errors.push(`Provider '${pname}': env var \${${varName}} is not set`)
          }
        }
      }
    }

    if (errors.length > 0) {
      p.log.error(`Validation failed (${errors.length} error(s)):`)
      for (const err of errors) {
        p.log.warn(err)
      }
      this.exit(1)
    } else {
      p.log.success('Configuration is valid')
      p.note(
        [
          `Model:     ${ACCENT(config.model.name)}`,
          `Providers: ${Object.keys(config.providers).length}`,
          `Routes:    ${config.text_routes.length}`,
          ...(Object.keys(config.modality_routes).length > 0
            ? [`Modalities: ${ACCENT(Object.keys(config.modality_routes).join(', '))}`]
            : []),
        ].join('\n'),
        'Summary',
      )
    }
  }
}
