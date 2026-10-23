import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as ipc from '../../ipc';
import { withConnectLog } from '../../connectLog';
import { useAppStore, buildJumpChain, resolveServerAuth } from '../../store/appStore';
import type { EditEvent, FileEntry, LogEntry, Server } from '../../types';
import { localStyle, styleFor } from '../../paths';
import type { OwnerChange } from './PermissionsDialog';
import { emptyListing, type Listing, type Notice, type PaneMode } from './panes';
import { holdConnection } from '../../heldConnections';

/**
 * One side of the panel.
 *
 * The two panes are the same machine: either can browse the local disk or
 * connect to a host, and each has its own local listing, remote listing,
 * session and connect progress. That was written out twice, under `local`/
 * `left` prefixes on one side and `rightLocal`/`remote`/`connect` on the
 * other, which is why there were two connect functions, two disconnects, four
 * navigate functions and twelve CRUD handlers for six operations.
 *
 * They differ in two things only, both arguments here: where they start, and
 * that the left pane loads the local home at mount while the right waits until
 * asked.
 */
export function usePane(initialMode: PaneMode) {
  const { servers, identities } = useAppStore();

  const [mode, setMode] = useState<PaneMode>(initialMode);
  const [local, setLocal] = useState<Listing>(emptyListing(initialMode === 'local'));
  const [remote, setRemote] = useState<Listing>(emptyListing(false));

  const [sid, setSid] = useState<string | null>(null);
  // Outlives `sid`: a dropped connection clears the session but keeps the
  // host, so the reconnect button knows what to reconnect to.
  const [serverId, setServerId] = useState<string | null>(null);
  const [serverName, setServerName] = useState('');
  const [disconnected, setDisconnected] = useState(false);

  // Separate from the listings: an operation that fails leaves the directory
  // it was working in perfectly readable, so its message must not take the
  // place of one.
  const [notice, setNotice] = useState<Notice | null>(null);

  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');
  const [connectLogs, setConnectLogs] = useState<LogEntry[]>([]);
  const [connectServer, setConnectServer] = useState<Server | null>(null);

  // The watcher behind an opened file reports on a channel named for the
  // session. Through a ref so the listener, bound once per session, calls
  // the refresh of the render it fires in rather than the one it was made in.
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!sid) return;
    const unlisten = listen<EditEvent>(`sftp-edit:${sid}`, (e) => {
      const { name, error } = e.payload;
      setNotice(error
        ? { text: `Could not upload ${name}: ${error}`, kind: 'error' }
        : { text: `Uploaded ${name}`, kind: 'info' });
      refreshRef.current();
    });
    return () => { unlisten.then((f) => f()); };
  }, [sid]);

  /** The listing the pane is currently showing, whichever side it is on. */
  const listing = mode === 'local' ? local : remote;
  const style = styleFor(mode === 'local' ? 'local' : 'remote');

  // The path and the rows change together, once the listing is in hand.
  // Switching the path first and the rows after showed the new crumbs over a
  // "Loading…" row, and a listing that then failed switched everything back:
  // a flicker for a directory the user could not read.
  async function navigateLocal(path: string) {
    if (path !== local.path) setNotice(null);
    setLocal((l) => ({ ...l, loading: true, error: '' }));
    try {
      const entries = await ipc.sftpListLocal(path);
      setLocal((l) => ({ ...l, path, entries, loading: false }));
    } catch (e) {
      setLocal((l) => ({ ...l, loading: false }));
      fail(String(e));
    }
  }

  async function navigateRemote(path: string, on: string | null = sid) {
    if (!on) return;
    const sid = on;
    if (path !== remote.path) setNotice(null);
    setRemote((r) => ({ ...r, loading: true, error: '' }));
    try {
      const entries = await ipc.sftpListRemote(sid, path);
      setRemote((r) => ({ ...r, path, entries, loading: false }));
    } catch (e) {
      // A listing fails for a path that is not there, or not readable, as
      // readily as for a link that has died, and every failure used to be
      // read as the second: a mistyped path put up the reconnect button. The
      // session is asked whether it still answers, and only silence is a
      // disconnect.
      const alive = await ipc.sftpProbeRemote(sid).catch(() => false);
      if (alive) {
        setRemote((r) => ({ ...r, loading: false }));
        fail(String(e));
        return;
      }
      setRemote((r) => ({ ...r, error: String(e), loading: false }));
      setDisconnected(true);
      setSid(null);
    }
  }

  /** Re-lists whichever side is showing, after a change made to it. */
  const refresh = () => (mode === 'local' ? navigateLocal(local.path) : navigateRemote(remote.path));
  refreshRef.current = refresh;

  /** Shows the local disk, fetching the home directory the first time only. */
  async function goLocal() {
    setMode('local');
    if (!local.path) {
      const home = await ipc.sftpLocalHome().catch(() => localStyle().defaultRoot);
      setLocal((l) => ({ ...l, home }));
      await navigateLocal(home);
    }
  }

  /** Resolves to the session id once the pane is on `server`, or null when it could not get there. */
  async function connect(server: Server): Promise<string | null> {
    // Resume the session already open for this host rather than making another.
    if (server.id === serverId && sid) {
      setMode('connected');
      return sid;
    }

    const resolved = await resolveServerAuth(server, identities);
    if (!resolved) {
      setConnectError(`No authentication configured for "${server.name}". Add a key, password or prompt auth in Hosts settings.`);
      return null;
    }
    const { username, authType, authValue } = resolved;

    setConnectingId(server.id);
    setConnectError('');
    setConnectLogs([]);
    setConnectServer(server);
    setMode('connecting');

    // Narrate the connect the same way a terminal session does, so a stall or
    // rejection is visible instead of leaving a bare spinner.
    const connectId = crypto.randomUUID();

    try {
      const newSid = await withConnectLog(
        connectId,
        (entry) => setConnectLogs((prev) => [...prev, entry]),
        async () => ipc.sftpConnectRemote(
          server.id,
          username,
          authType,
          authValue,
          connectId,
          await buildJumpChain(server, servers, identities),
        ),
      );
      setSid(newSid);
      setServerId(server.id);
      setServerName(server.name);
      setMode('connected');
      setDisconnected(false);
      setRemote((r) => ({ ...r, error: '', loading: true }));
      useAppStore.getState().autostartTunnels({ kind: 'connect', serverId: server.id });

      const home = await ipc.sftpGetHome(newSid);
      const entries = await ipc.sftpListRemote(newSid, home);
      setRemote({ path: home, entries, loading: false, error: '', home });
      return newSid;
    } catch (e) {
      // Stay on the connecting screen so the log explaining the failure, and
      // the retry button, are both still there.
      setConnectError(String(e));
      return null;
    } finally {
      setConnectingId(null);
      setRemote((r) => ({ ...r, loading: false }));
    }
  }

  async function disconnect() {
    if (sid) {
      await ipc.sftpDisconnectRemote(sid).catch(() => {});
    }
    setMode('idle');
    setSid(null);
    setServerId(null);
    setServerName('');
    setDisconnected(false);
    setRemote(emptyListing(false));
  }

  // Counted while open, so Android keeps it alive in the background, and
  // closed by the notification's "Disconnect all".
  const disconnectRef = useRef(disconnect);
  disconnectRef.current = disconnect;
  useEffect(() => {
    if (!sid) return;
    return holdConnection(() => { void disconnectRef.current(); });
  }, [sid]);

  /** Reconnects to the host whose session dropped, if there is one. */
  const reconnect = disconnected
    ? () => {
        const s = servers.find((sv) => sv.id === serverId);
        if (s) connect(s);
      }
    : undefined;

  // The six operations below were twelve handlers: one pair per operation,
  // differing only in which prefix they set and which navigate they called.

  /**
   * The remote session, insisted on rather than assumed.
   *
   * `sid` is null between a dropped connection and a reconnect, and every
   * remote command took it as-is: the null went across the bridge and came
   * back as a deserialize error naming a Rust type. The pane shows its
   * reconnect view in that state so none of these should be reachable, but
   * saying so out loud costs one line and turns an internal error into the
   * sentence the user needs.
   */
  function requireSid(): string {
    if (!sid) throw new Error('The connection to this server was lost');
    return sid;
  }

  async function newFolder(name: string) {
    const path = style.join(listing.path, name);
    try {
      if (mode === 'local') await ipc.sftpCreateLocalDir(path);
      else await ipc.sftpMkdir(requireSid(), path);
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  async function rename(entry: FileEntry, newName: string) {
    // The style knows where the parent ends, which is the whole reason it
    // exists: on Windows this is a backslash and the old lastIndexOf('/')
    // renamed the file into the root of the disk.
    const parent = style.parent(entry.path);
    if (parent === null) {
      fail(`Cannot rename ${entry.name}: it has no parent folder`);
      return;
    }
    try {
      const target = style.join(parent, newName);
      if (mode === 'local') await ipc.sftpRenameLocal(entry.path, target);
      else await ipc.sftpRenameRemote(requireSid(), entry.path, target);
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  async function removeMany(batch: FileEntry[]) {
    try {
      // The first failure stops the batch. The ones before it are gone, the
      // ones after it are untouched, and the refresh below shows exactly that.
      for (const entry of batch) {
        if (mode === 'local') await ipc.sftpDeleteLocal(entry.path);
        else await ipc.sftpDeleteRemote(requireSid(), entry.path, entry.is_dir);
      }
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  async function open(entry: FileEntry) {
    try {
      if (mode === 'local') {
        await ipc.sftpOpenLocal(entry.path);
      } else {
        await ipc.sftpOpenRemote(requireSid(), entry.path);
        say(`Opened ${entry.name}. Each save goes back to the server.`);
      }
    } catch (e) {
      fail(String(e));
    }
  }

  async function moveInto(batch: FileEntry[], dir: string) {
    try {
      for (const entry of batch) {
        if (dir === entry.path || dir.startsWith(entry.path + style.sep)) {
          throw new Error(`Cannot move ${entry.name} into itself`);
        }
        if (style.parent(entry.path) === dir) continue;
        const target = style.join(dir, entry.name);
        if (mode === 'local') await ipc.sftpRenameLocal(entry.path, target);
        else await ipc.sftpRenameRemote(requireSid(), entry.path, target);
      }
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  async function setPerms(batch: FileEntry[], newMode: number, owner: OwnerChange | null) {
    try {
      // The first failure stops the batch, same as removeMany: what came
      // before it is changed, what came after it is not, and the refresh
      // below shows exactly that. The mode goes first: a chown that is
      // refused still leaves the mode the user asked for.
      for (const entry of batch) {
        if (mode === 'local') await ipc.sftpSetModeLocal(entry.path, newMode);
        else await ipc.sftpSetModeRemote(requireSid(), entry.path, newMode);
        if (!owner) continue;
        if (mode === 'local') await ipc.sftpSetOwnerLocal(entry.path, owner.user, owner.group);
        else await ipc.sftpSetOwnerRemote(requireSid(), entry.path, owner.user, owner.group);
      }
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  /** Reports a failed operation without disturbing the list behind it. */
  function fail(message: string) {
    setNotice({ text: message, kind: 'error' });
  }

  /** Same place, for something that went well enough but is worth saying. */
  function say(message: string) {
    setNotice({ text: message, kind: 'info' });
  }

  return {
    mode, setMode, listing, style, local, remote, notice, dismissNotice: () => setNotice(null),
    sid, serverId, serverName, disconnected,
    connectingId, connectError, setConnectError, connectServer, connectLogs,
    navigate: (path: string) => (mode === 'local' ? navigateLocal(path) : navigateRemote(path)),
    refresh, goLocal, connect, disconnect, reconnect, navigateRemote,
    newFolder, rename, removeMany, setPerms, moveInto, open, fail, say, requireSid,
  };
}

export type Pane = ReturnType<typeof usePane>;
