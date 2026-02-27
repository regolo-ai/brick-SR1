/**
 * Brand color theme — chalk-based color constants.
 * Ported from Python ui.py brand colors.
 */

import chalk from 'chalk'

// Brand colors
export const ACCENT = chalk.hex('#00d4aa')
export const ACCENT_DIM = chalk.hex('#009977')
export const ACCENT_BOLD = chalk.hex('#00d4aa').bold
export const SUCCESS = chalk.hex('#00d4aa')
export const ERROR = chalk.hex('#ff5555')
export const WARN = chalk.hex('#ffaa00')
export const DIM = chalk.dim
export const BOLD = chalk.bold

// Feature colors
export const FEATURE_CYAN = chalk.hex('#00bcd4')
export const FEATURE_PURPLE = chalk.hex('#b388ff')

// Raw hex values (for libraries that need raw colors)
export const COLORS = {
  accent: '#00d4aa',
  accentDim: '#009977',
  success: '#00d4aa',
  error: '#ff5555',
  warn: '#ffaa00',
  textLight: '#e0e0e0',
  textDim: '#888888',
  featureCyan: '#00bcd4',
  featurePurple: '#b388ff',
} as const

// ASCII logo
const LOGO_RAW = `
     ___           ___           ___           ___           ___           ___           ___
    /\\__\\         |\\__\\         /\\__\\         /\\  \\         /\\  \\         /\\  \\         /\\__\\
   /::|  |        |:|  |       /::|  |       /::\\  \\       /::\\  \\       /::\\  \\       /:/  /
  /:|:|  |        |:|  |      /:|:|  |      /:/\\:\\  \\     /:/\\:\\  \\     /:/\\:\\  \\     /:/  /
 /:/|:|__|__      |:|__|__   /:/|:|__|__   /:/  \\:\\  \\   /:/  \\:\\__\\   /::\\~\\:\\  \\   /:/  /
/:/ |::::\\__\\     /::::\\__\\ /:/ |::::\\__\\ /:/__/ \\:\\__\\ /:/__/ \\:|__| /:/\\:\\ \\:\\__\\ /:/__/
\\/__/~~/:/  /    /:/~~/~    \\/__/~~/:/  / \\:\\  \\ /:/  / \\:\\  \\ /:/  / \\:\\~\\:\\ \\/__/ \\:\\  \\
      /:/  /    /:/  /            /:/  /   \\:\\  /:/  /   \\:\\  /:/  /   \\:\\ \\:\\__\\    \\:\\  \\
     /:/  /     \\/__/            /:/  /     \\:\\/:/  /     \\:\\/:/  /     \\:\\ \\/__/     \\:\\  \\
    /:/  /                      /:/  /       \\::/  /       \\::/__/       \\:\\__\\        \\:\\__\\
    \\/__/                       \\/__/         \\/__/         ~~            \\/__/         \\/__/`

/**
 * Print the branded ASCII logo to stdout.
 */
export function printLogo(): void {
  console.log(ACCENT(LOGO_RAW))
  console.log()
}
