/**
 * Whether a newer release exists, asked of GitHub.
 *
 * One anonymous GET of the releases endpoint from the webview; no HTTP
 * client on the Rust side. The CSP in tauri.conf.json lets exactly this
 * host through. Nothing here throws: a failed check is the same as no
 * news, since the app has no business complaining about the network on
 * the user's behalf.
 */

import { isAndroid } from './platform';

export const RELEASES_URL = 'https://github.com/AalmanSadath/BifroSSH/releases';
const LATEST_API = 'https://api.github.com/repos/AalmanSadath/BifroSSH/releases/latest';
const LIST_API = 'https://api.github.com/repos/AalmanSadath/BifroSSH/releases?per_page=50';

/** Android releases are tagged `android-vX.Y.Z` and numbered on their own. */
const ANDROID_TAG = 'android-v';

export interface Release {
  /** Without the leading `v`. */
  version: string;
  /** The release page, for the user to open. */
  url: string;
}

/** `v1.2.3` or `1.2.3` to its numbers; null for anything else. */
function parts(version: string): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Whether `latest` is newer than `current`. A version that does not parse
 * is never newer, so a tag named oddly cannot raise a false alarm.
 */
export function newerVersion(current: string, latest: string): boolean {
  const a = parts(current);
  const b = parts(latest);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

interface ListedRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/**
 * The newest Android release in GitHub's list, which is newest first. Android
 * releases are never marked latest, so that `/releases/latest` stays the
 * desktop one, and this has to look through the list instead.
 */
export function pickAndroidRelease(list: unknown): Release | null {
  if (!Array.isArray(list)) return null;
  for (const r of list as ListedRelease[]) {
    if (r.draft === true || r.prerelease === true) continue;
    if (typeof r.tag_name !== 'string' || !r.tag_name.startsWith(ANDROID_TAG)) continue;
    const version = r.tag_name.slice(ANDROID_TAG.length);
    if (!parts(version)) continue;
    return { version, url: typeof r.html_url === 'string' ? r.html_url : RELEASES_URL };
  }
  return null;
}

/**
 * The latest release, `'none'` when GitHub answered but has no release for
 * this platform yet, or null when GitHub could not be asked.
 */
export async function fetchLatestRelease(): Promise<Release | 'none' | null> {
  if (isAndroid) {
    try {
      const res = await fetch(LIST_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return null;
      const list: unknown = await res.json();
      if (!Array.isArray(list)) return null;
      return pickAndroidRelease(list) ?? 'none';
    } catch {
      return null;
    }
  }
  try {
    const res = await fetch(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const body = await res.json() as { tag_name?: unknown; html_url?: unknown };
    if (typeof body.tag_name !== 'string' || !parts(body.tag_name)) return null;
    return {
      version: body.tag_name.replace(/^v/, ''),
      url: typeof body.html_url === 'string' ? body.html_url : RELEASES_URL,
    };
  } catch {
    return null;
  }
}
