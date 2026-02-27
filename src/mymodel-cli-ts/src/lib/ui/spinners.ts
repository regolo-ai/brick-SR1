/**
 * Spinner helpers using @clack/prompts.
 *
 * Replaces ora with clack's built-in spinner for consistent
 * guide-line styling across the entire CLI.
 */

import * as p from '@clack/prompts'

/**
 * Create a clack spinner instance.
 * Usage:
 *   const s = spinner()
 *   s.start('Loading...')
 *   s.stop('Done!')
 */
export function spinner() {
  return p.spinner()
}

/**
 * Run an async function with a spinner.
 * Automatically starts/stops and handles errors.
 */
export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  doneMessage?: string,
): Promise<T> {
  const s = p.spinner()
  s.start(message)
  try {
    const result = await fn()
    s.stop(doneMessage ?? message.replace(/\.{3}$/, ''))
    return result
  } catch (error) {
    s.stop('Failed')
    throw error
  }
}
