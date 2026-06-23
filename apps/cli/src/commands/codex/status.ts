import { Command } from '@oclif/core';
import { isHealthy } from '../../lib/docker/serve.js';
import { DEFAULT_CODEX_PORT } from '../../lib/codex/bootstrap.js';
import { readCodexConfig, getTopLevelProfile, isWired, codexConfigPath } from '../../lib/codex/config-toml.js';
import { readCodexWiring } from '../../lib/codex/wiring-state.js';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m',
};
const tick = `${C.green}✓${C.reset}`;
const cross = `${C.red}✗${C.reset}`;

export default class CodexStatus extends Command {
  static description = 'Show whether OpenAI Codex is wired to the local Brick router.';

  static examples = ['<%= config.bin %> codex status'];

  async run(): Promise<void> {
    const wiring = readCodexWiring();
    const port = DEFAULT_CODEX_PORT;
    const baseUrl = wiring?.baseUrl ?? `http://localhost:${port}`;

    const text = readCodexConfig();
    const blockPresent = isWired(text);
    const activeProfile = getTopLevelProfile(text);
    const profilePointsBrick = activeProfile === 'brick';
    const wired = blockPresent && profilePointsBrick;

    const healthy = await isHealthy(port);

    this.log('');
    this.log(`${C.bold}${C.cyan}Codex wiring${C.reset}`);
    this.log(`  config.toml         ${codexConfigPath()}`);
    this.log(
      `  active profile      ${activeProfile ?? `${C.dim}(none)${C.reset}`}  ${
        wired ? `${tick} wired to brick` : `${cross} not wired`
      }`
    );
    this.log(`  brick provider      ${blockPresent ? `${tick} present (wire_api=chat)` : `${cross} absent`}`);
    this.log(`  brick router        ${baseUrl}  ${healthy ? `${tick} healthy` : `${cross} unreachable`}`);

    if (wiring?.mode) {
      this.log(`  mode                ${wiring.mode}`);
    }

    this.log('');
    if (!wired) {
      this.log(`${C.dim}Run \`brick codex on\` to route Codex through Brick.${C.reset}`);
    } else if (!healthy) {
      this.log(`${C.dim}Router is down — run \`brick serve\` or \`brick codex on\`.${C.reset}`);
    } else {
      this.log(`${C.dim}Codex routes among the OpenAI pool via the Brick skill router. Undo with \`brick codex off\`.${C.reset}`);
    }
  }
}
