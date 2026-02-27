/**
 * `mymodel route "<query>"` — test routing offline.
 *
 * Uses @clack/prompts note() for the result box and
 * clack spinner via withSpinner().
 */

import {Args} from '@oclif/core'
import * as p from '@clack/prompts'
import {BaseCommand} from '../base-command.js'
import {tryGoBinary, keywordMatch, type RoutingResult} from '../lib/route-test.js'
import {withSpinner} from '../lib/ui/spinners.js'
import {ACCENT, SUCCESS, ERROR, DIM} from '../lib/ui/theme.js'

export default class Route extends BaseCommand {
  static summary = 'Test routing for a query without starting the server'

  static args = {
    query: Args.string({description: 'The query to route', required: true}),
  }

  static examples = [
    '<%= config.bin %> route "write python code"',
    '<%= config.bin %> route "translate to French" --config ./my-config.yaml',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Route)
    const config = this.loadConfigOrExit(flags.config)

    // Try Go binary first
    let result = await withSpinner('Classifying query...', async () => {
      return tryGoBinary(args.query, flags.config)
    })

    // Fallback to keyword matching
    if (!result) {
      const start = performance.now()
      result = await withSpinner('Matching keywords...', async () => {
        return keywordMatch(args.query, config)
      })
      result.latency_ms = Math.round(performance.now() - start)
    }

    // Display result
    this.printRoutingResult(result)
  }

  private printRoutingResult(result: RoutingResult): void {
    const lines: string[] = []
    lines.push(`Query:      ${result.query}`)
    lines.push(`Modality:   ${result.modality ?? 'text'}`)
    lines.push('')

    const signals = result.signals as string[] | undefined
    if (signals && signals.length > 0) {
      lines.push('Signals:')
      for (const s of signals) {
        lines.push(`  ${SUCCESS('+')} ${s}`)
      }
    } else {
      lines.push(`Signals:    ${DIM('none')}`)
    }
    lines.push('')

    lines.push(`Route:      ${ACCENT(String(result.route_name ?? ''))}`)
    lines.push(`Provider:   ${result.provider}`)
    lines.push(`Model:      ${result.model}`)
    lines.push(`Reason:     ${DIM(String(result.reason ?? ''))}`)
    lines.push('')

    if (result.blocked) {
      lines.push(`Status:     ${ERROR(`BLOCKED — ${result.block_reason}`)}`)
    } else {
      lines.push(`PII:        ${SUCCESS('clean')}`)
      lines.push(`Jailbreak:  ${SUCCESS('clean')}`)
    }

    if (result.latency_ms) {
      lines.push(`Latency:    ${ACCENT(`${result.latency_ms}ms`)}`)
    }

    p.note(lines.join('\n'), 'Routing Result')
  }
}
