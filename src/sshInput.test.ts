import { describe, expect, it } from 'vitest';
import { parseSSHInput, parseSshUrl } from './sshInput';

describe('parseSSHInput', () => {
  it('takes a destination, with or without the command in front of it', () => {
    expect(parseSSHInput('root@example.com')).toEqual({ user: 'root', host: 'example.com', port: 22, password: undefined });
    expect(parseSSHInput('  ssh pi@10.0.0.5  ')).toMatchObject({ user: 'pi', host: '10.0.0.5', port: 22 });
    expect(parseSSHInput('SSH pi@10.0.0.5')).toMatchObject({ host: '10.0.0.5' });
  });

  it('reads a port in either spelling, joined or apart', () => {
    expect(parseSSHInput('ssh -p 2222 pi@box')?.port).toBe(2222);
    expect(parseSSHInput('ssh -p2222 pi@box')?.port).toBe(2222);
    expect(parseSSHInput('ssh --port 2222 pi@box')?.port).toBe(2222);
    expect(parseSSHInput('pi@box -p 2222')?.port).toBe(2222);
  });

  it('reads a password the same two ways', () => {
    expect(parseSSHInput('ssh -pw hunter2 pi@box')?.password).toBe('hunter2');
    expect(parseSSHInput('ssh -pwhunter2 pi@box')?.password).toBe('hunter2');
    expect(parseSSHInput('ssh --password hunter2 pi@box')?.password).toBe('hunter2');
    expect(parseSSHInput('pi@box')?.password).toBeUndefined();
  });

  it('keeps the host when a port is not a number, since the host is the part that matters', () => {
    expect(parseSSHInput('ssh -p abc pi@box')).toMatchObject({ host: 'box', port: 22 });
    expect(parseSSHInput('ssh -p 0 pi@box')?.port).toBe(22);
  });

  it('ignores flags it does not know rather than refusing the line', () => {
    expect(parseSSHInput('ssh -v -o StrictHostKeyChecking=no pi@box')).toMatchObject({ user: 'pi', host: 'box' });
  });

  it('finds nothing without a user and a host', () => {
    expect(parseSSHInput('')).toBeNull();
    expect(parseSSHInput('   ')).toBeNull();
    expect(parseSSHInput('ssh')).toBeNull();
    expect(parseSSHInput('example.com')).toBeNull();
    expect(parseSSHInput('@example.com')).toBeNull();
    expect(parseSSHInput('root@')).toBeNull();
    expect(parseSSHInput('ssh -p 22')).toBeNull();
  });

  it('splits on the first @, so a password-looking user is kept whole', () => {
    expect(parseSSHInput('user@name@host')).toMatchObject({ user: 'user', host: 'name@host' });
  });
});

describe('parseSshUrl', () => {
  it('reads user, host and port', () => {
    expect(parseSshUrl('ssh://alice@example.com:2222')).toEqual({ user: 'alice', host: 'example.com', port: 2222 });
  });

  it('defaults the port and leaves the user out when there is none', () => {
    expect(parseSshUrl('ssh://example.com/')).toEqual({ user: undefined, host: 'example.com', port: 22 });
  });

  it('drops connection parameters and decodes escapes', () => {
    expect(parseSshUrl('ssh://bob%40corp;fingerprint=ssh-ed25519-abc@h')).toEqual({ user: 'bob@corp', host: 'h', port: 22 });
  });

  it('takes the brackets off an IPv6 address', () => {
    expect(parseSshUrl('ssh://root@[fe80::1]:22')).toEqual({ user: 'root', host: 'fe80::1', port: 22 });
  });

  it('refuses what is not an ssh link or has a bad port', () => {
    expect(parseSshUrl('https://example.com')).toBeNull();
    expect(parseSshUrl('ssh://')).toBeNull();
    expect(parseSshUrl('ssh://h:70000')).toBeNull();
    expect(parseSshUrl('ssh://h/some/path')).toBeNull();
  });
});
