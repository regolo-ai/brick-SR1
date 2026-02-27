/**
 * oclif `init` hook — runs before every command.
 *
 * Shows the ASCII logo when the user runs:
 *   mymodel          (id = undefined)
 *   mymodel --help   (id = "--help")
 *   mymodel init     (id = "init")
 */

import {Hook} from '@oclif/core'
import {printLogo} from '../lib/ui/theme.js'

const LOGO_COMMANDS = new Set([undefined, '--help', 'init'])

const hook: Hook<'init'> = async function ({id}) {
  if (LOGO_COMMANDS.has(id)) {
    printLogo()
  }
}

export default hook
