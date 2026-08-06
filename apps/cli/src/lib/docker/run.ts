import { execa } from 'execa';
import { paths, resolveProfile } from '../config/paths.js';

export interface ExecResult { stdout: string; stderr: string; exitCode: number }

export function dockerComposeArgs(
  profile: string,
  composePath: string,
  args: string[],
  managedProject = true,
): string[] {
  const project = managedProject ? ['-p', `brick-${profile}`] : [];
  return ['compose', ...project, '-f', composePath, ...args];
}

export async function dockerCompose(profile: string | undefined, args: string[]): Promise<ExecResult> {
  const p = paths(resolveProfile(profile));
  const r = await execa('docker', dockerComposeArgs(p.profile, p.compose, args), { reject: false });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? 1 };
}

/**
 * Address profiles that were started directly with `docker compose -f ...`,
 * before Brick's managed project name was applied. Teardown commands can use
 * this fallback without risking a second stack being created.
 */
export async function dockerComposeDefaultProject(profile: string | undefined, args: string[]): Promise<ExecResult> {
  const p = paths(resolveProfile(profile));
  const r = await execa('docker', dockerComposeArgs(p.profile, p.compose, args, false), { reject: false });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? 1 };
}

export async function dockerCmd(args: string[]): Promise<ExecResult> {
  const r = await execa('docker', args, { reject: false });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? 1 };
}

export async function dockerInstalled(): Promise<boolean> {
  try {
    const r = await execa('docker', ['--version'], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
