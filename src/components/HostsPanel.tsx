import { useState } from 'react';
import * as ipc from '../ipc';
import { useAppStore, reportFailure } from '../store/appStore';
import { useHint } from './shared/useHint';
import { UNGROUPED, groupNames, groupOf, hostSections } from '../hosts';
import type { Server } from '../types';
import ServerForm from './ServerForm';
import SshConfigImport from './SshConfigImport';
import ClientImport from './ClientImport';
import OsIcon from './OsIcon';
import ConfirmModal from './shared/ConfirmModal';
import ContextMenu from './shared/ContextMenu';
import { cardKeys } from './shared/cardKeys';
import { EditIcon, NoteIcon } from './shared/icons';
import { probeClass, probeLabel, probeTitle } from '../probe';
import { tabLabel } from '../tabName';

export default function HostsPanel() {
  const { servers, sessions, setActiveTab, removeSession, deleteServer, openSession, hostProbes, probeHosts } = useAppStore();
  const [showServerForm, setShowServerForm] = useState(false);
  const [showSshImport, setShowSshImport] = useState(false);
  const [showClientImport, setShowClientImport] = useState(false);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ kind: 'server'; x: number; y: number; server: Server } | { kind: 'panel'; x: number; y: number } | null>(null);
  const [query, setQuery] = useState('');
  const hint = useHint();
  const [groupFilter, setGroupFilter] = useState<string | null>(null);

  const connectedIds = new Set(sessions.map((s) => s.server_id));
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

  async function handleDoubleClick(server: Server) {
    const existing = sessions.find((s) => s.server_id === server.id && s.status === 'connected');
    if (existing) { setActiveTab(existing.tab_id); return; }
    openSession(server.id);
  }

  function handleContextMenu(e: React.MouseEvent, server: Server) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ kind: 'server', x: e.clientX, y: e.clientY, server });
  }

  return (
    <>
      <div className="panel hosts-panel" onContextMenu={(e) => { if ((e.target as HTMLElement).closest('button, input, textarea, select, label, a')) return; e.preventDefault(); setContextMenu({ kind: 'panel', x: e.clientX, y: e.clientY }); }}>
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
              onChange={(e) => setQuery(e.target.value)}
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
                onClick={() => setGroupFilter(chip)}
              >
                {chip ?? 'All'}
              </button>
            ))}
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
                const connected = connectedIds.has(server.id);
                const isConnecting = sessions.some((s) => s.server_id === server.id && s.status === 'connecting');
                return (
                  <div
                    key={server.id}
                    className="host-card"
                    {...cardKeys(() => handleDoubleClick(server))}
                    onDoubleClick={() => handleDoubleClick(server)}
                    onContextMenu={(e) => handleContextMenu(e, server)}
                    title={hint('Double-click to connect · Right-click for options')}
                  >
                    <div className="host-card-icon">
                      <OsIcon os={server.os} size={28} />
                    </div>
                    <div className="host-card-info">
                      <div className="host-card-name-row">
                        {/* The dot is the whole status. Spelling it out underneath
                            gave the connected card a third line and made it taller
                            than the others in its row. */}
                        <span
                          className={`dot ${isConnecting ? 'dot-connecting' : connected ? 'dot-on' : 'dot-off'}`}
                          title={isConnecting ? 'Connecting…' : connected ? 'Connected' : 'Not connected'}
                        />
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
                  <button className="menu-item menu-item-danger" onClick={() => { setConfirmDeleteId(contextMenu.server.id); setContextMenu(null); }}>
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
          onDelete={editServer ? () => setConfirmDeleteId(editServer.id) : undefined}
        />
      )}
      {confirmDeleteId && (
        <ConfirmModal
          question="Delete this host?"
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => { deleteServer(confirmDeleteId).catch(reportFailure); setConfirmDeleteId(null); setShowServerForm(false); setEditServer(null); }}
        />
      )}
    </>
  );
}
