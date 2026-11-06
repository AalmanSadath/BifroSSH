import { describe, expect, it } from 'vitest';
import { bindWarning, isLoopback } from './bindAddress';

describe('isLoopback', () => {
  it('takes the empty default, localhost and the loopback ranges', () => {
    for (const a of ['', ' ', 'localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopback(a), a).toBe(true);
    }
  });

  it('treats every other address as reachable from elsewhere', () => {
    for (const a of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'myhost', '127.0.0.1.evil', '1270.0.0.1']) {
      expect(isLoopback(a), a).toBe(false);
    }
  });
});

describe('bindWarning', () => {
  it('says nothing for loopback', () => {
    expect(bindWarning('dynamic', '127.0.0.1', false)).toBeNull();
  });

  it('warns about an open proxy only for a SOCKS rule without a login', () => {
    expect(bindWarning('dynamic', '0.0.0.0', false)).toMatch(/proxy/);
    expect(bindWarning('dynamic', '0.0.0.0', true)).toMatch(/network/);
  });

  it('names GatewayPorts for a remote rule', () => {
    expect(bindWarning('remote', '0.0.0.0', false)).toMatch(/GatewayPorts/);
  });
});
