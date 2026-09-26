import { useEffect, useRef, useState } from 'react';
import * as ipc from '../ipc';
import { useAppStore, reportFailure } from '../store/appStore';
import { useHint } from './shared/useHint';
import { UNGROUPED, groupNames, groupOf, hostSections, hostStatus, type HostStatus } from '../hosts';
import type { Server } from '../types';
import ServerForm from './ServerForm';
import SshConfigImport from './SshConfigImport';
import ClientImport from './ClientImport';
import OsIcon from './OsIcon';
import ConfirmModal from './shared/ConfirmModal';
import ContextMenu from './shared/ContextMenu';
import MoveToGroupModal from './MoveToGroupModal';
import { EMPTY_SELECTION, clickSelect, inOrder, type Selection } from '../selection';
import { cardKeys } from './shared/cardKeys';
import { EditIcon, NoteIcon } from './shared/icons';
import { probeClass, probeLabel, probeTitle } from '../probe';
import { tabLabel } from '../tabName';

const STATUS_DOT: Record<HostStatus, { className: string; title: string }> = {
  connected: { className: 'dot-on', title: 'Connected' },
  connecting: { className: 'dot-connecting', title: 'Connecting…' },
  error: { className: 'dot-error', title: 'Could not connect, or the connection dropped' },
  off: { className: 'dot-off', title: 'Not connected' },
};

export default function HostsPanel() {
  const { servers, sessions, setActiveTab, removeSession, deleteServers, setServersGroup, openSession, hostProbes, probeHosts } = useAppStore();
  const [showServerForm, setShowServerForm] = useState(false);
  const [showSshImport, setShowSshImport] = useState(false);
  const [showClientImport, setShowClientImport] = useState(false);
  const [editServer, setEditServer] = useState<Server | null>(null);
  /** Hosts waiting on the delete confirmation: one from a card, or a selection. */
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const [contextMenu, setContextMenu] = useState<
    | { kind: 'server'; x: number; y: number; server: Server }
    | { kind: 'selection'; x: number; y: number }
    | { kind: 'panel'; x: number; y: number }
    | null
  >(null);
  const [query, setQuery] = useState('');
  const hint = useHint();
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [movingToGroup, setMovingToGroup] = useState(false);
  const connectingRef = useRef(false);

  const groups = groupNames(servers);
  const anyUngrouped = servers.some((s) => groupOf(s) === null);
  // A chip for a group that was renamed or emptied would keep the page
  // blank, so a filter that no longer names a group is dropped.
  const activeFilter = groupFilter !== null && (groups.includes(groupFilter) || (groupFilter === UNGROUPED && anyUngrouped))
    ? groupFilter : null;
  const sections = hostSections(servers, query, activeFilter);
  const checking = Object.values(hostProbes).includes('running');
  const chips = groups.length > 0
    ? [null, ...groups, ...(anyUngrouped ? [UNGROUPED] : [])]
    : [];
  // The cards in the order they are on screen, which is what a Shift-click
  // ranges over and the order a bulk action works through.
  const order = sections.flatMap((sec) => sec.servers.map((h) => h.id));
  const picked = inOrder(order, selection.selected);
  const nameOf = (id: string) => servers.find((h) => h.id === id)?.name ?? id;

  /** A different search or group is a different list; what was picked meant the old one. */
  function narrow(apply: () => void) {
    apply();
    setSelection(EMPTY_SELECTION);
  }

  function handleCardClick(e: React.MouseEvent, server: Server) {
    setSelection((cur) => clickSelect(order, cur, server.id, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey }));
  }

  /**
   * Opens each in the order shown, one after another as a restore does, so a
   * host that asks for a passphrase asks on its own. A host that already has
   * a working tab is left as it is rather than given a second one.
   */
  async function connectAll(ids: string[]) {
    if (connectingRef.current) return;
    connectingRef.current = true;
    try {
      for (const id of ids) {
        const open = useAppStore.getState().sessions.some((t) => t.server_id === id && t.status === 'connected');
        if (!open) await openSession(id);
      }
    } finally {
      connectingRef.current = false;
    }
  }

  function onPanelKeyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).closest('input, textarea, select')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelection({ selected: new Set(order), anchor: order[0] ?? null });
    } else if (e.key === 'Delete' && picked.length > 0) {
      setConfirmDelete(picked);
    }
  }

  async function handleDoubleClick(server: Server) {
    const existing = sessions.find((s) => s.server_id === server.id && s.status === 'connected');
    if (existing) { setActiveTab(existing.tab_id); return; }
    openSession(server.id);
  }

  // Escape lets go of the selection wherever focus is, since after a bulk
  // action it is rarely still on a card. Not while a dialog or a menu is up:
  // Escape there is for closing that.
  const anythingPicked = selection.selected.size > 0;
  const overlayOpen = movingToGroup || confirmDelete !== null || contextMenu !== null;
  useEffect(() => {
    if (!anythingPicked || overlayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelection(EMPTY_SELECTION);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anythingPicked, overlayOpen]);

  /** A click on the page that is not on a card, or on something to act with, lets go. */
  function onPanelMouseDown(e: React.MouseEvent) {
    if (!anythingPicked) return;
    if ((e.target as HTMLElement).closest('.host-card, .hosts-bulk-bar, button, input, a, label')) return;
    setSelection(EMPTY_SELECTION);
  }

  function handleContextMenu(e: React.MouseEvent, server: Server) {
    e.preventDefault();
    e.stopPropagation();
    // On one of several picked cards, the menu is about all of them. On any
    // other card it is about that card, which becomes the selection so the
    // two never disagree about what is being acted on.
    if (selection.selected.has(server.id) && picked.length > 1) {
      setContextMenu({ kind: 'selection', x: e.clientX, y: e.clientY });
      return;
    }
    setSelection({ selected: new Set([server.id]), anchor: server.id });
    setContextMenu({ kind: 'server', x: e.clientX, y: e.clientY, server });
  }

  return (
    <>
      <div className="panel hosts-panel" onKeyDown={onPanelKeyDown} onMouseDown={onPanelMouseDown} onContextMenu={(e) => { if ((e.target as HTMLElement).closest('button, input, textarea, select, label, a')) return; e.preventDefault(); setContextMenu({ kind: 'panel', x: e.clientX, y: e.clientY }); }}>
        <div className="panel-title-row">
          <div className="panel-title">Hosts</div>
        </div>
        <div className="panel-toolbar">
          <button className="btn-primary btn-sm" onClick={() => { setEditServer(null); setShowServerForm(true); }}>
            + Add Host
          </button>
          <button className="btn-secondary btn-sm" onClick={() => setShowSshImport(true)}>
            Import from ssh config
          </button>
          <button
            className="btn-secondary btn-sm"
            onClick={() => setShowClientImport(true)}
            title={hint('Hosts exported from Termius, PuTTY or MobaXterm')}
          >
            Import from another client
          </button>
          {servers.length > 0 && (
            <button
              className="btn-secondary btn-sm"
              onClick={() => { void probeHosts(sections.flatMap((sec) => sec.servers.map((h) => h.id)), true); }}
              disabled={checking}
              title={hint('Open a TCP connection to each host shown and time it. Nothing is authenticated.')}
            >
              {checking ? 'Checking…' : 'Check hosts'}
            </button>
          )}
          {servers.length > 0 && (
            <input
              className="hosts-search"
              type="text"
              placeholder="Filter by name, host, user, group or notes"
              value={query}
              onChange={(e) => narrow(() => setQuery(e.target.value))}
              spellCheck={false}
            />
          )}
        </div>

        {chips.length > 0 && (
          <div className="hosts-chips">
            {chips.map((chip) => (
              <button
                key={chip ?? ''}
                className={`hosts-chip${activeFilter === chip ? ' active' : ''}`}
                onClick={() => narrow(() => setGroupFilter(chip))}
              >
                {chip ?? 'All'}
              </button>
            ))}
          </div>
        )}

        {picked.length > 1 && (
          <div className="hosts-bulk-bar">
            <span className="hosts-bulk-count">{picked.length} selected</span>
            <button className="btn-secondary btn-sm" onClick={() => void connectAll(picked)}>Connect</button>
            <button className="btn-secondary btn-sm" onClick={() => setMovingToGroup(true)}>Move to group…</button>
            <button
              className="btn-secondary btn-sm"
              onClick={() => { void probeHosts(picked, true); }}
              disabled={checking}
              title={hint('Open a TCP connection to each selected host and time it. Nothing is authenticated.')}
            >
              Check
            </button>
            <button className="btn-danger btn-sm" onClick={() => setConfirmDelete(picked)}>Delete</button>
          </div>
        )}

        {servers.length === 0 ? (
          <div className="hosts-empty">
            <p>No hosts yet.</p>
            <button className="btn-primary" onClick={() => { setEditServer(null); setShowServerForm(true); }}>
              Add your first host
            </button>
          </div>
        ) : sections.length === 0 ? (
          <div className="hosts-empty">
            <p>No hosts match.</p>
          </div>
        ) : sections.map((section) => (
          <div key={section.group ?? ''} className="hosts-section">
            {/* One nameless section, when nothing is grouped, needs no title:
                the page then looks as it did before groups existed. */}
            {(section.group !== null || groups.length > 0) && (
              <div className="hosts-group-title">{section.group ?? UNGROUPED}</div>
            )}
            <div className="hosts-grid">
              {section.servers.map((server) => {
                const status = hostStatus(sessions.filter((s) => s.server_id === server.id));
                return (
                  <div
                    key={server.id}
                    className={`host-card${selection.selected.has(server.id) ? ' host-card-selected' : ''}`}
                    {...cardKeys(() => handleDoubleClick(server))}
                    onClick={(e) => handleCardClick(e, server)}
                    onDoubleClick={() => handleDoubleClick(server)}
                    onContextMenu={(e) => handleContextMenu(e, server)}
                    title={hint('Double-click to connect · Click to select, Ctrl or Shift to select several · Right-click for options')}
                  >
                    <div className="host-card-icon">
                      <OsIcon os={server.os} size={28} />
                    </div>
                    <div className="host-card-info">
                      <div className="host-card-name-row">
                        {/* The dot is the whole status. Spelling it out underneath
                            gave the connected card a third line and made it taller
                            than the others in its row. */}
                        <span className={`dot ${STATUS_DOT[status].className}`} title={STATUS_DOT[status].title} />
                        <span className="card-title">{server.name}</span>
                        {/* A glyph in the name row rather than a third line:
                            the card's two-line height is what keeps every card
                            in a row the same size. */}
                        {server.notes?.trim() && (
                          <span className="host-card-note" title={server.notes.trim().slice(0, 400)}>
                            <NoteIcon size={15} />
                          </span>
                        )}
                      </div>
                      {/* The check joins the address rather than taking a
                          line of its own: the card's two-line height is what
                          keeps every card in a row the same size. */}
                      <span className="card-sub" title={probeTitle(hostProbes[server.id])}>
                        {server.host}:{server.port}
                        {probeLabel(hostProbes[server.id]) !== null && (
                          <>
                            {' \u00b7 '}
                            <span className={`host-probe${probeClass(hostProbes[server.id])}`}>
                              {probeLabel(hostProbes[server.id])}
                            </span>
                          </>
                        )}
                      </span>
                    </div>
                    <button
                      className="host-card-edit-btn"
                      onClick={(e) => { e.stopPropagation(); setEditServer(server); setShowServerForm(true); }}
                      title={hint('Edit host')}
                    >
                      <EditIcon size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          {contextMenu.kind === 'panel' ? (
            <button className="menu-item" onClick={() => { setContextMenu(null); setEditServer(null); setShowServerForm(true); }}>
              Add Host
            </button>
          ) : contextMenu.kind === 'selection' ? (
            <>
              <button className="menu-item" onClick={() => { setContextMenu(null); void connectAll(picked); }}>
                Connect {picked.length}
              </button>
              <button className="menu-item" onClick={() => { setContextMenu(null); setMovingToGroup(true); }}>
                Move to group…
              </button>
              <button className="menu-item" onClick={() => { setContextMenu(null); void probeHosts(picked, true); }} disabled={checking}>
                Check {picked.length}
              </button>
              <div className="menu-divider" />
              <button className="menu-item menu-item-danger" onClick={() => { setContextMenu(null); setConfirmDelete(picked); }}>
                Remove {picked.length}
              </button>
            </>
          ) : (
            (() => {
              const activeSessions = sessions.filter((s) => s.server_id === contextMenu.server.id);
              return (
                <>
                  {activeSessions.length > 0 && (
                    <>
                      {activeSessions.map((s) => (
                        <button key={s.tab_id} className="menu-item menu-item-danger" onClick={() => {
                          if (s.session_id) ipc.sshDisconnect(s.session_id).catch(() => {});
                          removeSession(s.tab_id);
                          setContextMenu(null);
                        }}>
                          End {tabLabel(s)}
                        </button>
                      ))}
                      <div className="menu-divider" />
                    </>
                  )}
                  {/* Same action either way, but the word has to match what
                      it does: with nothing open there is nothing to duplicate,
                      and "Duplicate" read as though it would copy the host. */}
                  <button className="menu-item" onClick={() => { setContextMenu(null); openSession(contextMenu.server.id); }}>
                    {activeSessions.length > 0 ? 'Duplicate' : 'Connect'}
                  </button>
                  <button className="menu-item" onClick={() => { setContextMenu(null); setEditServer(contextMenu.server); setShowServerForm(true); }}>
                    Edit
                  </button>
                  <div className="menu-divider" />
                  <button className="menu-item menu-item-danger" onClick={() => { setConfirmDelete([contextMenu.server.id]); setContextMenu(null); }}>
                    Remove
                  </button>
                </>
              );
            })()
          )}
        </ContextMenu>
      )}

      {showSshImport && <SshConfigImport onClose={() => setShowSshImport(false)} />}

      {showClientImport && <ClientImport onClose={() => setShowClientImport(false)} />}

      {showServerForm && (
        <ServerForm
          server={editServer}
          onClose={() => { setShowServerForm(false); setEditServer(null); }}
          onDelete={editServer ? () => setConfirmDelete([editServer.id]) : undefined}
        />
      )}
      {movingToGroup && (
        <MoveToGroupModal
          count={picked.length}
          groups={groups}
          onClose={() => setMovingToGroup(false)}
          onMove={(group) => {
            setMovingToGroup(false);
            setServersGroup(picked, group).catch(reportFailure);
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          question={confirmDelete.length === 1 ? `Delete ${nameOf(confirmDelete[0])}?` : `Delete ${confirmDelete.length} hosts?`}
          hint={confirmDelete.length > 1
            ? `${confirmDelete.slice(0, 4).map(nameOf).join(', ')}${confirmDelete.length > 4 ? ` and ${confirmDelete.length - 4} more` : ''}. Their SFTP bookmarks go with them.`
            : undefined}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            deleteServers(confirmDelete).catch(reportFailure);
            setConfirmDelete(null);
            setSelection(EMPTY_SELECTION);
            setShowServerForm(false);
            setEditServer(null);
          }}
        />
      )}
    </>
  );
}
