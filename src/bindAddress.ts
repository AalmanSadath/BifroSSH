/**
 * Whether a forward's bind address keeps it to this one machine.
 *
 * Empty is loopback because the backend fills in 127.0.0.1 for it. Anything
 * else, a LAN address, 0.0.0.0, `::` or a hostname, is treated as reachable
 * from elsewhere: guessing wrong here costs a needless warning, not an open
 * port nobody was told about.
 */
export function isLoopback(address: string): boolean {
  const a = address.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return a === '' || a === 'localhost' || a === '::1' || /^127(\.\d{1,3}){3}$/.test(a);
}

/**
 * What to say under the bind address field, or null when it stays on this
 * machine. Advice only: binding wider is sometimes exactly what is wanted.
 */
export function bindWarning(
  type: 'local' | 'remote' | 'dynamic',
  address: string,
  hasLogin: boolean,
): string | null {
  if (isLoopback(address)) return null;
  if (type === 'remote') {
    return 'Other machines can reach this port on the server, if its sshd allows GatewayPorts.';
  }
  if (type === 'dynamic' && !hasLogin) {
    return 'Anyone who can reach this port can use the server as a proxy. Set a SOCKS login to limit it.';
  }
  return 'Other machines on your network can reach this port.';
}
