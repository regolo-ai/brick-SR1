/**
 * Wizard Step 1: Welcome banner using @clack/prompts intro().
 *
 * The ASCII logo is already shown by the oclif init hook,
 * so we just display the intro frame and description here.
 */

import * as p from '@clack/prompts'
import chalk from 'chalk'

const ACCENT = chalk.hex('#00d4aa')
const DIM = chalk.dim

export function showWelcome(): void {
  p.intro(ACCENT.bold(' mymodel setup '))

  p.log.message(
    [
      ACCENT.bold('MyModel — Create your personal AI model'),
      '',
      'Combine multiple LLM providers into a single, intelligent endpoint.',
      'Route requests by content, keywords, domains, and modality.',
      '',
      DIM('This wizard will guide you through 7 steps.'),
    ].join('\n'),
  )
}
