/**
 * Splitting and joining paths, for the two shapes this app has to hold at once.
 *
 * A remote path is always POSIX: it comes off an SFTP wire, and the server
 * decides what it means. A local path is whatever the machine the app is
 * running on uses, which is backslashes and a drive letter on Windows.
 *
 * Both used to be one hardcoded `split('/')`, which on Windows produced
 * breadcrumbs that navigated nowhere and a rename whose target was the root of
 * the disk. Hence one module: every place that takes a path apart asks for a
 * style first, and the style knows which shape it is.
 *
 * The backend counterpart is `join_remote` and `is_safe_name` in
 * `src-tauri/src/sftp/mod.rs`, which guard the same joins on the other side.
 */

export interface PathStyle {
  /** What this style writes between segments. */
  readonly sep: string;
  /** Where to start when nothing else is known. */
  readonly defaultRoot: string;
  /** True when `path` has no parent left. */
  isRoot(path: string): boolean;
  /** The containing directory, or null at the root. */
  parent(path: string): string | null;
  /** `dir` and `name` joined, with exactly one separator between them. */
  join(dir: string, name: string): string;
  /** One entry per breadcrumb, each carrying the path that crumb navigates to. */
  segments(path: string): { label: string; path: string }[];
  /** The last segment: a filename, or '' when the path is a root. */
  basename(path: string): string;
}

/** Remote paths, and local paths everywhere that is not Windows. */
export const posix: PathStyle = {
  sep: '/',
  defaultRoot: '/',

  isRoot: (path) => path === '/' || path === '',

  parent(path) {
    if (this.isRoot(path)) return null;
    const trimmed = path.replace(/\/+$/, '');
    const cut = trimmed.lastIndexOf('/');
    if (cut < 0) return null;
    return cut === 0 ? '/' : trimmed.slice(0, cut);
  },

  join: (dir, name) => (dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`),

  segments(path) {
    const parts = path.split('/').filter(Boolean);
    return parts.map((label, i) => ({
      label,
      path: '/' + parts.slice(0, i + 1).join('/'),
    }));
  },

  basename: (path) => path.replace(/\/+$/, '').split('/').pop() ?? '',
};

/**
 * Windows local paths.
 *
 * Both separators are accepted on the way in, because Win32 itself accepts
 * both and a path can arrive here having been through code that used the other
 * one. Everything written out uses a backslash.
 *
 * A root is a drive (`C:\`) or a UNC share (`\\server\share\`), and neither has
 * a parent — walking up from `C:\` would otherwise land on `` and list nothing.
 */
export const windows: PathStyle = {
  sep: '\\',
  defaultRoot: 'C:\\',

  isRoot: (path) => rootOf(path) !== null && stripRoot(path) === '',

  parent(path) {
    const root = rootOf(path);
    if (root === null) return null;
    const rest = stripRoot(path).split('\\').filter(Boolean);
    if (rest.length === 0) return null;
    rest.pop();
    return root + rest.join('\\');
  },

  join: (dir, name) => (dir.endsWith('\\') ? `${dir}${name}` : `${dir}\\${name}`),

  segments(path) {
    const root = rootOf(path);
    if (root === null) return [];
    const rest = stripRoot(path).split('\\').filter(Boolean);
    // The drive or share is a crumb of its own, so clicking it goes to the top
    // of that volume rather than nowhere.
    const crumbs = [{ label: root.replace(/\\+$/, ''), path: root }];
    rest.forEach((label, i) => {
      crumbs.push({ label, path: root + rest.slice(0, i + 1).join('\\') });
    });
    return crumbs;
  },

  basename: (path) => stripRoot(path).replace(/\\+$/, '').split('\\').pop() ?? '',
};

/** `C:\`, `\\server\share\`, or null when the path names no volume. */
function rootOf(path: string): string | null {
  const p = path.replace(/\//g, '\\');
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(p);
  if (unc) return unc[0] + '\\';
  const drive = /^[A-Za-z]:/.exec(p);
  if (drive) return drive[0] + '\\';
  return null;
}

function stripRoot(path: string): string {
  const p = path.replace(/\//g, '\\');
  const root = rootOf(p);
  return root === null ? p : p.slice(root.length);
}

/**
 * The style for paths on the machine the app is running on.
 *
 * Set once at startup from the `platform` command, because nothing in the
 * webview knows which OS it is on: `navigator.platform` is deprecated and the
 * Tauri webview does not have to tell the truth about it.
 */
let local: PathStyle = posix;

export function setLocalPlatform(os: string): void {
  local = os === 'windows' ? windows : posix;
}

export function localStyle(): PathStyle {
  return local;
}

/** Remote paths are POSIX whatever this machine is. */
export const remoteStyle: PathStyle = posix;

/** The style for whichever side of the SFTP panel is in view. */
export function styleFor(mode: 'local' | 'remote'): PathStyle {
  return mode === 'local' ? local : remoteStyle;
}
