import { useState, useRef, useEffect } from 'react';
import * as ipc from '../ipc';
import { envSummary } from '../envLines';
import { SHELLS, withIntegration } from '../shellIntegration';
import { useAppStore } from '../store/appStore';
import { useHint } from './shared/useHint';
import ThemePicker, { ThumbNail } from './ThemePicker';
import { THEMES } from '../styles/themes';
import { STORED } from '../types';
import type { Server } from '../types';
import Drawer from './shared/Drawer';
import { Picker, type PickerOption } from './settings/Picker';

type MonitorChoice = 'default' | 'always' | 'never';

const MONITOR_CHOICES: PickerOption<MonitorChoice>[] = [
  { value: 'default', label: 'As in Settings' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
];
import PortalDropdown, { PortalMenu, anchorBelow, type AnchorRect } from './shared/PortalDropdown';
import PassphraseInput from './shared/PassphraseInput';

interface Props {
  server: Server | null;
  onClose: () => void;
  onDelete?: () => void;
}

export default function ServerForm({ server, onClose, onDelete }: Props) {
  const { servers, identities, keys, saveServer, customThemes, settings, setActiveTab } = useAppStore();
  const hint = useHint();

  const [name, setName] = useState(server?.name ?? '');
  const [host, setHost] = useState(server?.host ?? '');
  const [port, setPort] = useState(server?.port ?? 22);
  const [identityId, setIdentityId] = useState(server?.identity_id ?? '');
  const [username, setUsername] = useState(server?.username ?? '');
  const [password, setPassword] = useState('');

  // Mount only, and deliberately so: this fills the box with what is already
  // stored, and re-running it when the prop changes would put the saved
  // password back over whatever the user had started typing. The drawer is
  // built fresh per host, so the prop does not change under it anyway.
  //
  // The cancel flag is not about the dependency list. A drawer closed while
  // the keychain read is still in flight used to set state on a component
  // that had gone.
  useEffect(() => {
    if (!server?.id || server.encrypted_password !== STORED) return;
    let cancelled = false;
    ipc.getServerPassword(server.id)
      .then((pw) => { if (!cancelled) setPassword(pw); })
      .catch(() => {});
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [keyId, setKeyId] = useState(server?.key_id ?? '');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<AnchorRect | null>(null);
  const usernameGroupRef = useRef<HTMLDivElement>(null);
  const passwordGroupRef = useRef<HTMLDivElement>(null);
  // A new host starts from the default in Settings rather than from one
  // hardcoded theme, which is what that setting is for.
  const [themeOverride, setThemeOverride] = useState<string>(server?.theme ?? settings.theme);
  const [timeoutSecs, setTimeoutSecs] = useState<string>(server?.connection_timeout != null ? String(server.connection_timeout) : '');
  const [proxyJump, setProxyJump] = useState(server?.proxy_jump ?? '');
  const [forwardAgent, setForwardAgent] = useState(server?.forward_agent ?? false);
  const [logSessions, setLogSessions] = useState(server?.log_sessions ?? false);
  const [group, setGroup] = useState(server?.group ?? '');
  const [runOnConnect, setRunOnConnect] = useState(server?.run_on_connect ?? '');
  const [hideRunOnConnect, setHideRunOnConnect] = useState(server?.hide_run_on_connect ?? true);
  const [notes, setNotes] = useState(server?.notes ?? '');
  const [term, setTerm] = useState(server?.term ?? '');
  const [env, setEnv] = useState(server?.env ?? '');
  const [monitor, setMonitor] = useState<MonitorChoice>(
    server?.monitor === true ? 'always' : server?.monitor === false ? 'never' : 'default',
  );
  const [showGroups, setShowGroups] = useState(false);
  const [groupRect, setGroupRect] = useState<AnchorRect | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const [themeExpanded, setThemeExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedIdentity = identities.find((i) => i.id === identityId) ?? null;
  const selectedKey = keys.find((k) => k.id === keyId) ?? null;

  const suggestions = identities.filter((i) => {
    if (!username && !password) return false;
    if (username) return i.username.toLowerCase().includes(username.toLowerCase()) || i.name.toLowerCase().includes(username.toLowerCase());
    return true;
  });

  // Groups already in use, offered under the box so the same one is spelled
  // the same way twice. Narrowed by what has been typed so far.
  const groupSuggestions = Array.from(new Set(
    servers.map((s) => s.group?.trim() ?? '').filter((g) => g !== ''),
  ))
    .filter((g) => g.toLowerCase().includes(group.trim().toLowerCase()) && g !== group.trim())
    .sort((a, b) => a.localeCompare(b));

  function pickIdentity(id: string) {
    setIdentityId(id);
    setUsername('');
    setPassword('');
    setKeyId('');
    setShowSuggestions(false);
  }

  function removeIdentity() {
    setIdentityId('');
    setUsername('');
    setPassword('');
    setKeyId('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !host.trim()) { setError('Name and host are required'); return; }
    setSaving(true);
    setError('');
    try {
      const parsed = parseInt(timeoutSecs, 10);
      await saveServer(
        {
          id: server?.id,
          name: name.trim(),
          host: host.trim(),
          port,
          identity_id: identityId || null,
          username: (!identityId && username.trim()) ? username.trim() : null,
          encrypted_password: null,
          key_id: (!identityId && keyId) ? keyId : null,
          theme: themeOverride as string | null,
          connection_timeout: timeoutSecs.trim() === '' || isNaN(parsed) ? null : Math.max(1, parsed),
          // Set on the identity, not here; preserved so editing a host does not clear it.
          auth_kind: server?.auth_kind ?? null,
          proxy_jump: proxyJump || null,
          forward_agent: forwardAgent,
          log_sessions: logSessions,
          group: group.trim() || null,
          run_on_connect: runOnConnect.trim() || null,
          hide_run_on_connect: hideRunOnConnect,
          notes: notes.trim() || null,
          term: term.trim() || null,
          env: env.trim() === '' ? null : env,
          monitor: monitor === 'default' ? null : monitor === 'always',
        },
        (!identityId && !keyId && password.trim()) ? password.trim() : undefined,
      );
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  // Offering a host that already reaches this one through its own chain would
  // build a loop the connection could never resolve, so those are left out
  // rather than allowed and rejected at connect time.
  const jumpCandidates = servers.filter((candidate) => {
    if (candidate.id === server?.id) return false;
    // A host being created has nothing pointing at it yet, so no chain
    // through it can exist to loop back.
    if (!server) return true;
    const seen = new Set<string>();
    let hop: Server | undefined = candidate;
    while (hop?.proxy_jump && !seen.has(hop.id)) {
      seen.add(hop.id);
      if (hop.proxy_jump === server.id) return false;
      hop = servers.find((s) => s.id === hop!.proxy_jump);
    }
    return true;
  });

  return (
    <Drawer
      title={server ? 'Edit Host' : 'Add Host'}
      onClose={onClose}
      action={
        <button type="submit" form="host-form" className="btn-primary btn-sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <div className="drawer-body">
        <form id="host-form" className="inline-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production Web" autoFocus />
          </div>
          <div className="form-row">
            <div className="form-group flex-1">
              <label>Host</label>
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.100" />
            </div>
            <div className="form-group port-group">
              <label>Port</label>
              <input type="number" className="no-spinner" value={port} min={1} max={65535} onChange={(e) => setPort(Number(e.target.value))} />
            </div>
          </div>

          {selectedIdentity ? (
            <div className="form-group">
              <label>Identity</label>
              <div className="host-identity-badge">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                </svg>
                <span className="host-identity-badge-name">{selectedIdentity.name}</span>
                <span className="host-identity-badge-user">{selectedIdentity.username}</span>
                <button type="button" className="host-identity-badge-remove" onClick={removeIdentity}>✕</button>
              </div>
            </div>
          ) : (
            <>
              <div className="form-group" ref={usernameGroupRef}>
                <label>Username</label>
                <input
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); setShowSuggestions(true); }}
                  onFocus={() => {
                    const r = usernameGroupRef.current?.getBoundingClientRect();
                    if (r) setDropdownRect({ top: r.bottom + 2, left: r.left, width: r.width });
                    setShowSuggestions(true);
                  }}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  placeholder="ubuntu"
                  autoComplete="off"
                />
              </div>
              <div className="form-group" ref={passwordGroupRef}>
                <label>Password</label>
                <PassphraseInput
                  value={password}
                  onChange={(v) => { setPassword(v); setShowSuggestions(true); }}
                  onFocus={() => {
                    setDropdownRect(anchorBelow(passwordGroupRef.current));
                    setShowSuggestions(true);
                  }}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  placeholder="leave blank to use key or prompt"
                />
              </div>
              <div className="form-group">
                <label>Key</label>
                <div className="picker">
                  <PortalDropdown label={selectedKey?.name ?? 'Select key…'}>
                    {(close) => (
                      <>
                        {keys.map((k) => (
                          <button
                            key={k.id}
                            type="button"
                            className={`picker-item${keyId === k.id ? ' selected' : ''}`}
                            onMouseDown={(e) => { e.preventDefault(); setKeyId(keyId === k.id ? '' : k.id); close(); }}
                          >
                            {k.name}
                          </button>
                        ))}
                        {keys.length > 0 && <div className="picker-divider" />}
                        <button
                          type="button"
                          className="picker-item picker-add"
                          onMouseDown={(e) => { e.preventDefault(); close(); setActiveTab('keychain'); onClose(); }}
                        >
                          + Add Key…
                        </button>
                      </>
                    )}
                  </PortalDropdown>
                </div>
              </div>
              {showSuggestions && dropdownRect && (() => {
                const items = suggestions.length > 0 ? suggestions : (!username ? identities : []);
                if (items.length === 0) return null;
                return (
                  <PortalMenu rect={dropdownRect}>
                    {items.map((i) => (
                      <button
                        key={i.id}
                        type="button"
                        className="picker-item"
                        onMouseDown={(e) => { e.preventDefault(); pickIdentity(i.id); }}
                      >
                        {i.name} <span style={{ opacity: 0.6 }}>({i.username})</span>
                        <span className="host-suggestion-type">
                          {i.auth_kind === 'keyboard-interactive'
                            ? 'prompt'
                            : i.auth_kind === 'agent'
                              ? 'ssh-agent'
                              : i.encrypted_password === STORED ? 'password' : 'key'}
                        </span>
                      </button>
                    ))}
                  </PortalMenu>
                );
              })()}
            </>
          )}

          <div className="form-group">
            <label>Jump Host</label>
            <select value={proxyJump} onChange={(e) => setProxyJump(e.target.value)}>
              <option value="">Connect directly</option>
              {jumpCandidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} ({candidate.host})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group" ref={groupRef}>
            <label>Group</label>
            <input
              value={group}
              onChange={(e) => { setGroup(e.target.value); setShowGroups(true); }}
              onFocus={() => { setGroupRect(anchorBelow(groupRef.current)); setShowGroups(true); }}
              onBlur={() => setTimeout(() => setShowGroups(false), 150)}
              placeholder="Production"
              autoComplete="off"
            />
          </div>
          {showGroups && groupRect && groupSuggestions.length > 0 && (
            <PortalMenu rect={groupRect}>
              {groupSuggestions.map((g) => (
                <button
                  key={g}
                  type="button"
                  className="picker-item"
                  onMouseDown={(e) => { e.preventDefault(); setGroup(g); setShowGroups(false); }}
                >
                  {g}
                </button>
              ))}
            </PortalMenu>
          )}

          {/* Not inside a form-group: the row carries its own bottom margin,
              and the group's on top of it put twice the gap below the box that
              there was above it. The tradeoff of ssh -A lives in the tooltip
              and the README rather than under the box. */}
          <label
            className="checkbox-row"
            title={hint("The same as ssh -A. Anyone with root on this host can use your agent's keys while the session is open.")}
          >
            <input
              type="checkbox"
              checked={forwardAgent}
              onChange={(e) => setForwardAgent(e.target.checked)}
            />
            <span>Forward ssh-agent to this host</span>
          </label>
          <label
            className="checkbox-row"
            title={hint('Everything the session prints is written to a file in the session logs folder, set in Settings.')}
          >
            <input
              type="checkbox"
              checked={logSessions}
              onChange={(e) => setLogSessions(e.target.checked)}
            />
            <span>Log every session to a file</span>
          </label>

          <div className="form-group">
            <label>Monitor Bar</label>
            <Picker value={monitor} options={MONITOR_CHOICES} onChange={setMonitor} />
            <p className="form-hint">
              CPU, memory, disk and network under this host's terminals, read every 3 seconds
              over the same connection. Linux hosts only.
            </p>
          </div>

          <div className="form-group">
            <label>Run on Connect</label>
            <input
              value={runOnConnect}
              onChange={(e) => setRunOnConnect(e.target.value)}
              placeholder="tmux attach || tmux new"
              autoComplete="off"
              spellCheck={false}
              title={hint('Sent to the shell as if typed, followed by Enter, once the shell is up.')}
            />
            {/* The line is typed at the shell, so the shell echoes it above
                the first prompt. The app knows the bytes it sent and takes
                them back out of the output, which leaves the banner and the
                prompt exactly as they were. Off for a command whose being
                typed is the point. */}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={hideRunOnConnect}
                disabled={runOnConnect.trim() === ''}
                onChange={(e) => setHideRunOnConnect(e.target.checked)}
              />
              <span>Keep it out of the terminal</span>
            </label>

            {/* What the tab's activity chip needs from the far end. Added
                rather than sent on its own: this host's shell is something
                only the person who set it up knows. */}
            <div className="shell-integration-row">
              <span className="form-hint">Shell integration, for the tab's activity chip:</span>
              {SHELLS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  className="sftp-action-btn"
                  onClick={() => setRunOnConnect((v) => withIntegration(v, id))}
                  title={`Add the ${label} marks to what this host runs on connect`}
                >
                  Add for {label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>Terminal Type</label>
            <input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="xterm-256color"
              autoComplete="off"
              spellCheck={false}
              title={hint('What TERM is set to on this host. Try xterm for a server whose curses library does not know the default.')}
            />
          </div>

          <div className="form-group">
            <label>Environment</label>
            <textarea
              className="notes-area"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={3}
              placeholder={'LANG=en_GB.UTF-8\nEDITOR=vim'}
              spellCheck={false}
              title={hint('One NAME=value per line, asked for before the shell starts.')}
            />
            <p className="form-hint">
              A server chooses which of these it will accept, usually LANG and LC_* only, and
              drops the rest without saying so. The terminal type above always applies.
              {envSummary(env) && <> {envSummary(env)}</>}
            </p>
          </div>

          <div className="form-group">
            <label>Notes</label>
            <textarea
              className="notes-area"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="What this host is for, who else uses it, anything worth remembering"
            />
            <p className="form-hint">
              Shown on the host card and searched with the name and address. Not a place for
              passwords: a key or a password belongs in the fields above, where it is kept
              encrypted and never shown again.
            </p>
          </div>

          <div className="form-group">
            <label>Connection Attempt Timeout (seconds)</label>
            <input
              type="number"
              min={1}
              max={3600}
              className="no-spinner"
              value={timeoutSecs}
              onChange={(e) => setTimeoutSecs(e.target.value)}
              placeholder="Global default (60s)"
            />
          </div>
          <div className="form-group">
            <div className="theme-current-row">
              <div className="theme-current-thumb">
                <ThumbNail id={themeOverride} />
              </div>
              <span className="theme-current-name">{(THEMES[themeOverride] ?? customThemes[themeOverride])?.name ?? themeOverride}</span>
            </div>
            <button
              type="button"
              className="theme-show-more-btn"
              onClick={() => setThemeExpanded((v) => !v)}
            >
              {themeExpanded ? 'Show less ∧' : 'Show more ∨'}
            </button>
            {themeExpanded && (
              <ThemePicker
                value={themeOverride}
                onChange={(id) => { setThemeOverride(id); setThemeExpanded(false); }}
              />
            )}
          </div>
          {error && <p className="form-error">{error}</p>}
        </form>
      </div>
      {(onDelete || server) && (
        <div className="drawer-footer">
          {onDelete && <button className="btn-danger btn-sm" onClick={onDelete}>Delete Host</button>}
          {server && (
            <button
              className="btn-primary btn-sm"
              onClick={() => { onClose(); useAppStore.getState().openSession(server.id); }}
            >
              Connect
            </button>
          )}
        </div>
      )}
    </Drawer>
  );
}
