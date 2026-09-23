import { useEffect, useMemo, useRef, useState } from 'react';
import * as ipc from '../ipc';
import { useAppStore } from '../store/appStore';
import { bySection, rankCommands, type Command } from '../palette';
import type { Codeprint, SettingsSection } from '../types';

interface Props {
  onClose: () => void;
  /** A codeprint the user picked; App sends it, since it owns the variable prompt. */
  onCodeprint: (cp: Codeprint) => void;
  /** Opens the Add Host drawer on the hosts page. */
  onAddHost: () => void;
  /** Locks the vault, the same call the shortcut makes. */
  onLock: () => void;
}

// SFTP is not here: the panel and the hosts that open in it share a
// section of their own, since "sftp" is what the user types for either.
const PANELS: { id: string; label: string }[] = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'portforwarding', label: 'Port Forwarding' },
  { id: 'keychain', label: 'Keychain' },
  { id: 'knownhosts', label: 'Known Hosts' },
  { id: 'theme-editor', label: 'Theme Editor' },
];

// Settings is not one panel any more but a rail of categories, so the
// palette offers the categories rather than the door they are behind.
const SETTINGS_SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'shortcuts', label: 'Keyboard shortcuts' },
  { id: 'connection', label: 'Connection' },
  { id: 'security', label: 'Security' },
  { id: 'data', label: 'Backup and transfer' },
  { id: 'about', label: 'About' },
];

/**
 * Ctrl+K: one box over everything that finds a host, a tab, a panel, a
 * codeprint or an action by a few letters of its name. Everything it does
 * is something the app could already do somewhere else; what it saves is
 * knowing where that somewhere is.
 */
export default function CommandPalette({ onClose, onCodeprint, onAddHost, onLock }: Props) {
  const {
    servers, sessions, activeTabId, codeprints, setActiveTab, openSession, openInSftp,
    removeSession, toggleBroadcast, toggleLogging, checkForUpdates, openSettings,
  } = useAppStore();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const active = sessions.find((s) => s.tab_id === activeTabId) ?? null;

  const commands = useMemo<Command[]>(() => {
    const done = (f: () => void) => () => { onClose(); f(); };
    const items: Command[] = [];

    for (const s of sessions) {
      if (s.tab_id === activeTabId) continue;
      items.push({
        id: `tab:${s.tab_id}`,
        title: s.server_name,
        subtitle: `Open tab · ${s.status}`,
        group: 'Tabs',
        run: done(() => setActiveTab(s.tab_id)),
      });
    }

    for (const server of servers) {
      const where = `${server.username ? `${server.username}@` : ''}${server.host}:${server.port}`;
      const sub = server.group ? `${where} · ${server.group}` : where;
      items.push({
        id: `host:${server.id}`,
        title: server.name,
        subtitle: sub,
        group: 'Hosts',
        run: done(() => { void openSession(server.id); }),
      });
      items.push({
        id: `sftp:${server.id}`,
        title: `${server.name} in SFTP`,
        subtitle: sub,
        group: 'SFTP',
        run: done(() => openInSftp(server.id, '~')),
      });
    }

    if (active) {
      for (const cp of codeprints) {
        items.push({
          id: `codeprint:${cp.id}`,
          title: cp.name,
          subtitle: cp.command,
          group: 'Codeprints',
          run: done(() => onCodeprint(cp)),
        });
      }
    }

    items.push({
      id: 'panel:sftp',
      title: 'SFTP panel',
      subtitle: 'Wherever the panes were left',
      group: 'SFTP',
      run: done(() => setActiveTab('sftp')),
    });

    for (const panel of PANELS) {
      items.push({
        id: `panel:${panel.id}`,
        title: panel.label,
        subtitle: 'Panel',
        group: 'Panels',
        run: done(() => setActiveTab(panel.id)),
      });
    }

    for (const section of SETTINGS_SECTIONS) {
      items.push({
        id: `settings:${section.id}`,
        title: section.label,
        subtitle: 'Settings',
        group: 'Panels',
        run: done(() => openSettings(section.id)),
      });
    }

    items.push({ id: 'action:add-host', title: 'Add host', group: 'Actions', run: done(onAddHost) });
    if (active?.server_id && !active.quick_info) {
      items.push({
        id: 'action:duplicate',
        title: 'New tab to this host',
        subtitle: active.server_name,
        group: 'Actions',
        run: done(() => { void openSession(active.server_id); }),
      });
    }
    if (active) {
      items.push({
        id: 'action:broadcast',
        title: active.broadcast ? 'Stop broadcasting input' : 'Broadcast input to marked tabs',
        group: 'Actions',
        run: done(() => toggleBroadcast(active.tab_id)),
      });
      items.push({
        id: 'action:log',
        title: active.logging === 'tab' ? 'Stop logging this tab' : 'Log this tab to a file',
        group: 'Actions',
        run: done(() => { void toggleLogging(active.tab_id); }),
      });
      items.push({
        id: 'action:close',
        title: 'Close this tab',
        subtitle: active.server_name,
        group: 'Actions',
        run: done(() => {
          if (active.session_id) ipc.sshDisconnect(active.session_id).catch(() => {});
          removeSession(active.tab_id);
        }),
      });
    }
    items.push({ id: 'action:lock', title: 'Lock the vault', group: 'Actions', run: done(onLock) });
    items.push({
      id: 'action:updates',
      title: 'Check for updates',
      group: 'Actions',
      run: done(() => { void checkForUpdates(true); openSettings('about'); }),
    });
    return items;
  // The store actions are stable; the lists are what this depends on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers, sessions, activeTabId, codeprints]);

  const matches = useMemo(() => rankCommands(commands, query), [commands, query]);
  const shown = useMemo(() => bySection(matches), [matches]);
  // The sections reorder the matches, so the cursor walks the shown order.
  const flat = useMemo(() => shown.flatMap((s) => s.commands), [shown]);
  const at = Math.min(cursor, Math.max(0, flat.length - 1));

  useEffect(() => { setCursor(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item-active')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, flat.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return; }
    if (e.key === 'Enter') { e.preventDefault(); flat[at]?.run(); }
  }

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Go to a host, tab, panel or codeprint"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <div className="palette-list" ref={listRef}>
          {flat.length === 0 && <div className="palette-empty">Nothing matches.</div>}
          {shown.map((section) => (
            <div key={section.group}>
              <div className="palette-group">{section.group}</div>
              {section.commands.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`palette-item${flat[at]?.id === c.id ? ' palette-item-active' : ''}`}
                  // Mouse down would take focus off the input before the click.
                  onMouseMove={() => setCursor(flat.findIndex((f) => f.id === c.id))}
                  onClick={c.run}
                >
                  <span className="palette-item-title">{c.title}</span>
                  {c.subtitle && <span className="palette-item-sub">{c.subtitle}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
