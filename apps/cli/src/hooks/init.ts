import type { Hook } from '@oclif/core';
import { printLogo } from '../lib/ui/banners.js';
import { ensureMigrated } from '../lib/config/migrate.js';
import { ensureDefaultProfile } from '../lib/claude/bootstrap.js';
import { ensureDefaultCodexProfile } from '../lib/codex/bootstrap.js';
import { ensureDefaultOpencodeProfile } from '../lib/opencode/bootstrap.js';

const hook: Hook<'init'> = async function () {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.some(value => ['help', '--help', '-h'].includes(value))) {
    printLogo();
    return;
  }
  if (argv.includes('--version')) return;
  await ensureMigrated();
  if (argv[0] === 'profile' && argv[1] === 'edit') {
    if (argv[2] === 'claude') await ensureDefaultProfile();
    if (argv[2] === 'codex') await ensureDefaultCodexProfile();
    if (argv[2] === 'opencode') await ensureDefaultOpencodeProfile();
  }
  if (['start', 'restart'].includes(argv[0])) {
    if (argv[1] === 'claude') await ensureDefaultProfile();
    if (argv[1] === 'codex') await ensureDefaultCodexProfile({ resetPool: argv[0] === 'start' && argv.includes('--reset-pool') });
    if (argv[1] === 'opencode') await ensureDefaultOpencodeProfile();
  }
};
export default hook;
