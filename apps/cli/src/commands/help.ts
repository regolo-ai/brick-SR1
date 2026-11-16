import { Args, Command } from '@oclif/core'
import { Help } from '@oclif/core'

export default class HelpCommand extends Command {
  static description = 'Display help for brick'
  static usage = 'help [COMMAND]'
  static args = {
    command: Args.string({
      description: 'command to show help for',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const { args } = await this.parse(HelpCommand)
    const help = new Help(this.config)
    if (args.command) {
      await help.showHelp([args.command])
    } else {
      await help.showHelp([])
    }
  }
}
