import { Args, Command, Flags } from '@oclif/core';
import { open } from 'node:fs/promises';
import { resolveProfile } from '../lib/config/paths.js';
import { logPath } from '../lib/runtime/process.js';
export default class Logs extends Command {
  static description = 'Read a profile runtime log';
  static args = { profile: Args.string({ required: true }) };
  static flags = { tail: Flags.integer({ default: 100, min: 1 }), follow: Flags.boolean({ char: 'f', default: false }) };
  async run(): Promise<void> {
    const { args, flags } = await this.parse(Logs);
    const file = await open(logPath(resolveProfile(args.profile)), 'r');
    let stopped = false;
    const stop = () => { stopped = true; };
    process.once('SIGINT', stop);
    try {
      const size = (await file.stat()).size;
      const start = Math.max(0, size - 1024 * 1024);
      const first = Buffer.alloc(size - start);
      await file.read(first, 0, first.length, start);
      this.log(first.toString('utf8').split('\n').slice(-flags.tail - 1).join('\n'));
      let offset = size;
      while (flags.follow && !stopped) {
        await new Promise(resolve => setTimeout(resolve, 250));
        const size = (await file.stat()).size;
        if (size < offset) offset = 0;
        if (size > offset) {
          const data = Buffer.alloc(Math.min(size - offset, 65536));
          const result = await file.read(data, 0, data.length, offset);
          process.stdout.write(data.subarray(0, result.bytesRead)); offset += result.bytesRead;
        }
      }
    } finally { process.removeListener('SIGINT', stop); await file.close(); }
  }
}
