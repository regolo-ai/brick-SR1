import chalk from 'chalk';

// Brand colors (ported from the early CLI MVP theme.ts)
export const ACCENT = chalk.hex('#00d4aa');
export const ACCENT_DIM = chalk.hex('#009977');
export const ACCENT_BOLD = chalk.hex('#00d4aa').bold;
export const SUCCESS = chalk.hex('#00d4aa');
export const ERROR = chalk.hex('#ff5555');
export const WARN = chalk.hex('#ffaa00');
export const FEATURE_CYAN = chalk.hex('#00bcd4');
export const FEATURE_PURPLE = chalk.hex('#b388ff');

const LOGO_LINES = [
  '██████╗ ██████╗ ██╗ ██████╗██╗  ██╗',
  '██╔══██╗██╔══██╗██║██╔════╝██║ ██╔╝',
  '██████╔╝██████╔╝██║██║     █████╔╝ ',
  '██╔══██╗██╔══██╗██║██║     ██╔═██╗ ',
  '██████╔╝██║  ██║██║╚██████╗██║  ██╗',
  '╚═════╝ ╚═╝  ╚═╝╚═╝ ╚═════╝╚═╝  ╚═╝',
];

export const LEFT_PAD = '  ';

export function printLogo(): void {
  console.log();
  for (const line of LOGO_LINES) console.log(LEFT_PAD + ACCENT(line));
  console.log();
}

export function header(text: string): void {
  console.log('\n' + LEFT_PAD + ACCENT_BOLD('━━━ ' + text + ' ' + '━'.repeat(Math.max(0, 60 - text.length))));
}

/** Like console.log but with a left-padding margin from the terminal edge. */
export function print(text: string = ''): void {
  if (!text) { console.log(); return; }
  for (const line of text.split('\n')) console.log(LEFT_PAD + line);
}

export function ok(text: string): void {
  console.log(SUCCESS('  ✓ ') + text);
}

export function warn(text: string): void {
  console.log(WARN('  ! ') + text);
}

export function err(text: string): void {
  console.log(ERROR('  ✗ ') + text);
}

export function info(text: string): void {
  console.log(chalk.dim('  · ') + text);
}

export function banner(): void {
  printLogo();
  console.log(LEFT_PAD + ACCENT_DIM('   self-hosted spatial router gateway'));
  console.log();
}
