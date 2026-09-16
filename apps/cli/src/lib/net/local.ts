// Use IPv4 loopback consistently with the native runtime listener.
export const ROUTER_HOST = '127.0.0.1';

/** `http://127.0.0.1:<port>` — canonical base URL for the local router. */
export function localBaseUrl(port: number | string): string {
  return `http://${ROUTER_HOST}:${port}`;
}
