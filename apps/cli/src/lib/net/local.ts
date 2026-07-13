// Loopback host for every URL that addresses the local Brick router — used for
// health probes, the base URL wired into Claude Code / Codex, and CLI→router
// calls (chat, route, generate, status, metrics).
//
// Why 127.0.0.1 and not `localhost`:
// On Windows, `localhost` resolves to `::1` (IPv6) before `127.0.0.1` (IPv4),
// and Docker Desktop's WSL2 port relay (wslrelay) frequently gets stuck on the
// IPv6 loopback after a container (re)start: it accepts the TCP connection but
// never forwards it, so every request hangs until timeout. The router is
// perfectly healthy on IPv4 the whole time. Switching Claude routing modes
// restarts the router, which re-triggers the stuck relay — which is why a
// working setup would suddenly look "disconnected" right after a mode change.
//
// Pinning the IPv4 loopback sidesteps the relay entirely and is equally correct
// on Linux and macOS, where 127.0.0.1 and localhost both reach the mapped port.
export const ROUTER_HOST = '127.0.0.1';

/** `http://127.0.0.1:<port>` — canonical base URL for the local router. */
export function localBaseUrl(port: number | string): string {
  return `http://${ROUTER_HOST}:${port}`;
}
