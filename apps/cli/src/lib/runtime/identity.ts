import { runtimeStatus } from './process.js';
export async function profileRunning(profile: string, port: number, rejectForeign = true): Promise<boolean> {
 const state = await runtimeStatus(profile);
 if (!state) return false;
 if (state.port !== port) { if (rejectForeign) throw new Error(`Profile '${profile}' is running on port ${state.port}`); return false; }
 return true;
}
