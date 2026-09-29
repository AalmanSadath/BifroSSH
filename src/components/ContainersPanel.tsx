import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as ipc from '../ipc';
import { useAppStore, buildJumpChain, resolveServerAuth, reportFailure } from '../store/appStore';
import { matchesHost } from '../hosts';
import { useHint } from './shared/useHint';
import ContextMenu from './shared/ContextMenu';
import ConnectingView from './ConnectingView';
import Modal from './shared/Modal';
import OsIcon from './OsIcon';
import type { Container, ContainerListing, ContainerTab, LogEntry, Server } from '../types';

type Action = 'start' | 'stop' | 'restart';

/** A connect in progress or failed, with its transcript, for ConnectingView. */
interface Connecting {
  server: Server;
  logs: LogEntry[];
  error?: string;
}

const ENGINE_LABEL = { docker: 'Docker', podman: 'Podman' } as const;

/** A row's identity: root's Podman and the user's are separate stores. */
const rowKey = (c: Container) => `${c.root ? 'root' : 'user'}:${c.engine}:${c.id}`;

/** What a row says while its action runs, which for a stop can be ten seconds. */
const PENDING: Record<Action, string> = { start: 'starting', stop: 'stopping', restart: 'restarting' };

/** States the engine reports on the way from one state to another. */
const TRANSITIONAL = new Set(['starting', 'stopping', 'restarting', 'removing']);

/** The badge's look: running, on the way somewhere, or not running. */
function stateClass(state: string): string {
  if (state === 'running') return 'running';
  return TRANSITIONAL.has(state) ? 'pending' : 'stopped';
}

/**
 * The containers on a saved host: their state, and a shell or their logs in
 * a terminal tab.
 *
 * The panel has its own connection, like SFTP, so it works with no terminal
 * open. It is kept in the store, so moving to another panel and back finds
 * it still there; the listing is read again each time the panel shows.
 */
export default function ContainersPanel() {
  const { servers, identities, openSession, containersConn, setContainersConn } = useAppStore();
  const hint = useHint();
  const [hostQuery, setHostQuery] = useState('');
  const [query, setQuery] = useState('');
  const [connecting, setConnecting] = useState<Connecting | null>(null);
  const [listing, setListing] = useState<ContainerListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Containers with a start, stop or restart in flight, by engine and id. */
  const [busy, setBusy] = useState<Map<string, Action>>(new Map());
  const [menu, setMenu] = useState<{ x: number; y: number; container: Container } | null>(null);
  /** The sudo password prompt, while it is open. */
  const [sudoPrompt, setSudoPrompt] = useState<{ password: string; error: string | null; busy: boolean } | null>(null);

  const server = containersConn ? servers.find((s) => s.id === containersConn.serverId) ?? null : null;

  const refresh = useCallback(async () => {
    if (!containersConn) return;
    setLoading(true);
    try {
      setListing(await ipc.containersList(containersConn.connId));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [containersConn]);

  // Read again whenever the panel shows or the connection changes.
  useEffect(() => { void refresh(); }, [refresh]);

  async function connect(target: Server) {
    if (containersConn) {
      if (containersConn.serverId === target.id && !error) return;
      void ipc.containersDisconnect(containersConn.connId).catch(() => {});
      setContainersConn(null);
    }
    setListing(null);
    setError(null);

    const resolved = await resolveServerAuth(target, identities);
    if (!resolved) {
      setConnecting({
        server: target,
        logs: [],
        error: `No authentication is configured for "${target.name}". Add a key, password or prompt auth in its settings.`,
      });
      return;
    }
    setConnecting({ server: target, logs: [] });
    const connectId = crypto.randomUUID();
    const unlisten = await listen<LogEntry>(`ssh-connect-log:${connectId}`, (event) => {
      setConnecting((c) => (c && c.server.id === target.id ? { ...c, logs: [...c.logs, event.payload] } : c));
    });
    try {
      const connId = await ipc.containersConnect(
        target.id,
        resolved.username,
        resolved.authType,
        resolved.authValue,
        connectId,
        await buildJumpChain(target, servers, identities),
      );
      setContainersConn({ serverId: target.id, connId, sudo: false });
      setConnecting(null);
    } catch (e) {
      setConnecting((c) => (c ? { ...c, error: String(e) } : c));
    } finally {
      // Trailing log lines race the invoke response over the same bridge.
      setTimeout(unlisten, 1000);
    }
  }

  async function disconnect() {
    if (containersConn) await ipc.containersDisconnect(containersConn.connId).catch(() => {});
    setContainersConn(null);
    setListing(null);
    setError(null);
  }

  async function act(container: Container, action: Action) {
    if (!containersConn) return;
    const key = rowKey(container);
    setBusy((b) => new Map(b).set(key, action));
    try {
      await ipc.containersAction(containersConn.connId, container.engine, container.id, action, container.root);
    } catch (e) {
      reportFailure(e);
    } finally {
      // Read before the row lets go of its pending state, so it goes from
      // "stopping" to what the engine now says rather than back through
      // "running" for a moment.
      await refresh();
      setBusy((b) => { const next = new Map(b); next.delete(key); return next; });
    }
  }

  function openTab(container: Container, kind: ContainerTab['kind']) {
    if (!server || !containersConn) return;
    void openSession(server.id, undefined, {
      engine: container.engine,
      id: container.id,
      name: container.name,
      kind,
      // Only root's containers go through sudo; the user's own open as the user.
      sudo: container.root || undefined,
    });
  }

  async function sudoOn() {
    if (!containersConn || !sudoPrompt) return;
    setSudoPrompt({ ...sudoPrompt, busy: true, error: null });
    try {
      await ipc.containersSudoOn(containersConn.connId, sudoPrompt.password || null);
      setSudoPrompt(null);
      setContainersConn({ ...containersConn, sudo: true });
    } catch (e) {
      setSudoPrompt({ password: '', busy: false, error: String(e) });
    }
  }

  async function sudoOff() {
    if (!containersConn) return;
    await ipc.containersSudoOff(containersConn.connId).catch(() => {});
    setContainersConn({ ...containersConn, sudo: false });
  }

  const hosts = servers.filter((s) => matchesHost(s, hostQuery));
  const q = query.trim().toLowerCase();
  const shown = (listing?.containers ?? []).filter((c) =>
    q === '' || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q));
  const bothEngines = new Set(listing?.engines.map((e) => e.engine)).size > 1;

  return (
    <div className="panel containers-panel">
      <div className="panel-title">Containers</div>
      <div className="containers-body">
        <div className="containers-hosts">
          <input
            className="containers-search"
            type="text"
            placeholder="Filter hosts"
            value={hostQuery}
            onChange={(e) => setHostQuery(e.target.value)}
            spellCheck={false}
          />
          <div className="containers-host-list">
            {servers.length === 0 ? (
              <p className="list-empty">No hosts yet. Add one in Hosts.</p>
            ) : hosts.length === 0 ? (
              <p className="list-empty">No hosts match.</p>
            ) : hosts.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`containers-host${(containersConn?.serverId ?? connecting?.server.id) === s.id ? ' active' : ''}`}
                onClick={() => void connect(s)}
                title={`${s.host}:${s.port}`}
              >
                <OsIcon os={s.os} size={22} />
                <span className="containers-host-name">{s.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="containers-main">
          {connecting ? (
            <ConnectingView
              server={connecting.server}
              logs={connecting.logs}
              error={connecting.error}
              onClose={() => setConnecting(null)}
              onRetry={connecting.error ? () => void connect(connecting.server) : undefined}
            />
          ) : !containersConn || !server ? (
            <p className="list-empty containers-idle">
              Pick a host to see its Docker and Podman containers.
            </p>
          ) : (
            <>
              <div className="containers-toolbar">
                <span className="containers-toolbar-host">{server.name}</span>
                {listing && listing.engines.length > 0 && (
                  <span className="containers-engines">{listing.engines.map((e) => ENGINE_LABEL[e.engine] + (e.root ? ' (root)' : '')).join(' + ')}</span>
                )}
                <input
                  className="containers-search"
                  type="text"
                  placeholder="Filter by name or image"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  spellCheck={false}
                />
                <button className="btn-secondary btn-sm" onClick={() => void refresh()} disabled={loading}>
                  {loading ? 'Refreshing…' : 'Refresh'}
                </button>
                {containersConn.sudo ? (
                  <button className="btn-secondary btn-sm" onClick={() => void sudoOff()}>Stop sudo</button>
                ) : (
                  <button
                    className="btn-secondary btn-sm"
                    onClick={() => setSudoPrompt({ password: '', error: null, busy: false })}
                    title={hint('Run listings, actions and container tabs as root')}
                  >
                    Use sudo
                  </button>
                )}
                <button className="btn-secondary btn-sm" onClick={() => void disconnect()}>Disconnect</button>
              </div>

              {error ? (
                <div className="containers-error">
                  <p className="form-error">{error}</p>
                  <button className="btn-secondary btn-sm" onClick={() => void connect(server)}>Connect again</button>
                </div>
              ) : (
                <>
                  {containersConn.sudo && (
                    <div className="containers-sudo-banner" role="alert">
                      <strong>Using sudo on {server.name}.</strong> Root's containers are listed as well as
                      yours, marked <span className="containers-root">root</span>. Starting, stopping or opening
                      one of those runs as root.
                    </div>
                  )}
                  {listing?.problems.map((p) => <p key={p} className="form-hint containers-problem">{p}</p>)}
                  {!listing ? (
                    <p className="form-hint">Reading the containers…</p>
                  ) : listing.containers.length === 0 ? (
                    <p className="list-empty">No containers on this host.</p>
                  ) : shown.length === 0 ? (
                    <p className="list-empty">No containers match.</p>
                  ) : (
                    <div className="containers-table">
                      {shown.map((c) => {
                        const inFlight = busy.get(rowKey(c));
                        const pending = inFlight !== undefined || TRANSITIONAL.has(c.state);
                        const shownState = inFlight ? PENDING[inFlight] : c.state;
                        const running = c.state === 'running' && !inFlight;
                        return (
                          <div
                            key={rowKey(c)}
                            className="containers-row"
                            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, container: c }); }}
                            onDoubleClick={() => { if (running) openTab(c, 'shell'); }}
                          >
                            <span className={`containers-state containers-state-${stateClass(shownState)}`} title={c.status}>
                              {shownState}
                            </span>
                            <div className="containers-row-text">
                              <span className="containers-name">
                                {c.name}
                                {c.root && <span className="containers-root" title="Root's: runs through sudo">root</span>}
                                {bothEngines && <span className="containers-engine">{ENGINE_LABEL[c.engine]}</span>}
                              </span>
                              <span className="containers-detail" title={c.image}>{c.image}</span>
                              <span className="containers-detail">
                                {c.status}{c.ports && ` · ${c.ports}`}
                              </span>
                            </div>
                            <div className="containers-actions">
                              <button
                                className="btn-secondary btn-sm"
                                disabled={!running || pending}
                                onClick={() => openTab(c, 'shell')}
                                title={hint(running ? 'Open a shell inside it' : 'Start it first')}
                              >
                                Shell
                              </button>
                              <button className="btn-secondary btn-sm" onClick={() => openTab(c, 'logs')} title={hint('Follow its output')}>
                                Logs
                              </button>
                              <button className="btn-secondary btn-sm" disabled={pending} onClick={() => void act(c, running ? 'stop' : 'start')}>
                                {running || (c.state === 'running' && pending) ? 'Stop' : 'Start'}
                              </button>
                              <button className="btn-secondary btn-sm" disabled={pending || !running} onClick={() => void act(c, 'restart')}>
                                Restart
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {sudoPrompt && server && (
        <Modal
          title={`Use sudo on ${server.name}`}
          onClose={() => setSudoPrompt(null)}
          onSubmit={(e) => { e.preventDefault(); void sudoOn(); }}
        >
          <p className="form-hint">
            Listings, start, stop and restart, and Shell and Logs tabs opened from this panel will run as
            root on {server.name} until you press Stop sudo, disconnect or lock the app.
          </p>
          <div className="form-group">
            <label htmlFor="sudo-password">Your password on {server.name}</label>
            <input
              id="sudo-password"
              type="password"
              autoFocus
              autoComplete="off"
              value={sudoPrompt.password}
              onChange={(e) => setSudoPrompt({ ...sudoPrompt, password: e.target.value, error: null })}
              disabled={sudoPrompt.busy}
            />
          </div>
          <p className="form-hint">
            Checked with sudo before it is used. It stays in memory only, is never saved, and is given to
            sudo on its input, never on a command line. Leave it empty if sudo on this host asks for none.
          </p>
          {sudoPrompt.error && <p className="form-error">{sudoPrompt.error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setSudoPrompt(null)}>Cancel</button>
            <button type="submit" className="btn-danger" disabled={sudoPrompt.busy}>
              {sudoPrompt.busy ? 'Checking…' : 'Use sudo'}
            </button>
          </div>
        </Modal>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button
            className="menu-item"
            disabled={menu.container.state !== 'running' || busy.has(rowKey(menu.container))}
            onClick={() => { openTab(menu.container, 'shell'); setMenu(null); }}
          >
            Shell
          </button>
          <button className="menu-item" onClick={() => { openTab(menu.container, 'logs'); setMenu(null); }}>Logs</button>
          <div className="menu-divider" />
          {busy.has(rowKey(menu.container)) || TRANSITIONAL.has(menu.container.state) ? (
            <button className="menu-item" disabled>{PENDING[busy.get(rowKey(menu.container)) ?? 'stop']}…</button>
          ) : menu.container.state === 'running' ? (
            <>
              <button className="menu-item" onClick={() => { void act(menu.container, 'stop'); setMenu(null); }}>Stop</button>
              <button className="menu-item" onClick={() => { void act(menu.container, 'restart'); setMenu(null); }}>Restart</button>
            </>
          ) : (
            <button className="menu-item" onClick={() => { void act(menu.container, 'start'); setMenu(null); }}>Start</button>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
