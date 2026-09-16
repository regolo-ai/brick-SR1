import type { Hook } from '@oclif/core';
import { printLogo } from '../lib/ui/banners.js';
import { ensureMigrated } from '../lib/config/migrate.js';
import { ensureDefaultProfile } from '../lib/claude/bootstrap.js';
import { ensureDefaultCodexProfile } from '../lib/codex/bootstrap.js';

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
  }
  if (['start', 'restart'].includes(argv[0])) {
    if (argv[1] === 'claude') await ensureDefaultProfile();
    if (argv[1] === 'codex') await ensureDefaultCodexProfile();
  }
};
export default hook;
