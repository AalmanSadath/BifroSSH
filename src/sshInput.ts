/**
 * What the quick connect box makes of a typed line.
 *
 * Accepts what someone would paste from a terminal or a wiki: a
 * `user@host`, optionally with `ssh` in front of it, a port in any of the
 * spellings ssh itself takes, and a password flag this app understands and
 * ssh does not. Everything else in the line is ignored rather than refused,
 * because a pasted command often carries flags that mean nothing here.
 */

export interface SSHInput {
  user: string;
  host: string;
  port: number;
  password?: string;
}

/** What ssh uses when nothing says otherwise. */
const DEFAULT_PORT = 22;

/**
 * The line, or null when it names no host to connect to.
 *
 * A port that is not a number falls back to 22 rather than refusing the
 * line: the destination is the part worth being strict about, and a typo in
 * a flag should not swallow a host that was typed correctly.
 */
export function parseSSHInput(input: string): SSHInput | null {
  let line = input.trim();
  if (line.toLowerCase().startsWith('ssh ')) line = line.slice(4).trim();
  if (!line) return null;

  let port = DEFAULT_PORT;
  let password: string | undefined;
  const tokens = line.split(/\s+/);
  const remaining: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if ((token === '-p' || token === '--port') && tokens[i + 1]) {
      port = parseInt(tokens[++i], 10) || DEFAULT_PORT;
    } else if (/^-p\d+$/.test(token)) {
      port = parseInt(token.slice(2), 10) || DEFAULT_PORT;
    } else if ((token === '-pw' || token === '--password') && tokens[i + 1]) {
      password = tokens[++i];
    } else if (token.startsWith('-pw') && token.length > 3) {
      password = token.slice(3);
    } else {
      remaining.push(token);
    }
  }

  const dest = remaining.find((t) => t.includes('@'));
  if (!dest) return null;
  const at = dest.indexOf('@');
  const user = dest.slice(0, at);
  const host = dest.slice(at + 1);
  if (!user || !host) return null;
  return { user, host, port, password };
}

/** Where an `ssh://` link points. No user when the link names none. */
export interface SSHUrl {
  user?: string;
  host: string;
  port: number;
}

/**
 * An `ssh://[user[;params]@]host[:port][/]` link, as RFC draft
 * draft-ietf-secsh-scp-sftp-ssh-uri has it, or null when it is not one.
 *
 * The connection parameters after `;` (a host key fingerprint, mostly) are
 * dropped: nothing here would act on them. An IPv6 address comes in
 * brackets and leaves without them.
 */
export function parseSshUrl(url: string): SSHUrl | null {
  const m = /^ssh:\/\/(?:([^@/]*)@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d*))?\/?$/i.exec(url.trim());
  if (!m) return null;
  const [, userInfo, rawHost, rawPort] = m;
  let user: string | undefined;
  let host: string;
  try {
    user = userInfo ? decodeURIComponent(userInfo.split(';')[0]) || undefined : undefined;
    host = decodeURIComponent(rawHost.replace(/^\[|\]$/g, ''));
  } catch {
    return null;
  }
  if (!host) return null;
  const port = rawPort ? Number(rawPort) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { user, host, port };
}
