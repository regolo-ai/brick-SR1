/**
 * Styled output helpers — @clack/prompts log wrappers.
 *
 * Replaces the old chalk-only helpers with clack's built-in
 * log.* utilities for consistent guide-line styling.
 */

import * as p from '@clack/prompts'
import {ACCENT_BOLD, ACCENT} from './theme.js'

export function printStep(step: number, total: number, title: string): void {
  p.log.step(`${ACCENT_BOLD(`Step ${step}/${total}`)} — ${title}`)
}

export function printOk(message: string): void {
  p.log.success(message)
}

export function printErr(message: string): void {
  p.log.error(message)
}

export function printWarn(message: string): void {
  p.log.warn(message)
}

export function printDim(message: string): void {
  p.log.message(message)
}

export function printHeader(title: string, subtitle?: string): void {
  const msg = subtitle ? `${ACCENT_BOLD(title)}\n${subtitle}` : ACCENT_BOLD(title)
  p.log.info(msg)
}

/**
 * Display a boxed note (replaces boxen).
 */
export function printNote(content: string, title?: string): void {
  p.note(content, title)
}

/**
 * Check if stdin is a TTY (interactive terminal).
 */
export function requireTty(): void {
  if (!process.stdin.isTTY) {
    p.cancel('Interactive terminal required. Cannot run in non-interactive mode.')
    process.exit(1)
  }
}
