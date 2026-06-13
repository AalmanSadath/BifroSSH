import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { THEMES } from '../styles/themes';

interface Props {
  activeSessionId: string | null;
}

export default function TerminalSidebar({ activeSessionId }: Props) {
  const {
    settings, customThemes, codeprints,
    addCodeprint, deleteCodeprint,
    sessionThemeOverrides, setSessionTheme,
  } = useAppStore();

  const hint = (t: string) => settings.show_hover_hints ? t : undefined;

  const [section, setSection] = useState<'codeprints' | 'theme'>('codeprints');
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const currentTheme = activeSessionId
    ? (sessionThemeOverrides[activeSessionId] ?? settings.theme)
    : settings.theme;

  function sendToTerminal(text: string, run: boolean) {
    if (!activeSessionId) return;
    const payload = run ? text + '\n' : text;
    const bytes = Array.from(new TextEncoder().encode(payload));
    invoke('ssh_send_input', { sessionId: activeSessionId, data: bytes }).catch(() => {});
  }

  function saveCodeprint() {
    if (!newName.trim() || !newCommand.trim()) return;
    addCodeprint({ name: newName.trim(), command: newCommand });
    setNewName('');
    setNewCommand('');
    setShowNewForm(false);
  }

  function cancelNew() {
    setShowNewForm(false);
    setNewName('');
    setNewCommand('');
  }

  return (
    <div className="term-sidebar">
      <div className="term-sidebar-tabs">
        <button
          className={`term-sidebar-tab${section === 'codeprints' ? ' active' : ''}`}
          onClick={() => setSection('codeprints')}
        >
          Codeprints
        </button>
        <button
          className={`term-sidebar-tab${section === 'theme' ? ' active' : ''}`}
          onClick={() => setSection('theme')}
        >
          Theme
        </button>
      </div>

      {section === 'codeprints' && (
        <div className="term-sidebar-body">
          {showNewForm ? (
            <div className="term-sidebar-new-form">
              <input
                className="term-sidebar-name-input"
                placeholder="Name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
              />
              <textarea
                className="term-sidebar-cmd-input"
                placeholder="Command"
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveCodeprint(); }}
                rows={4}
              />
              <div className="term-sidebar-form-btns">
                <button className="btn-secondary btn-sm" onClick={cancelNew}>Cancel</button>
                <button
                  className="btn-primary btn-sm"
                  onClick={saveCodeprint}
                  disabled={!newName.trim() || !newCommand.trim()}
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <button className="term-sidebar-new-btn" onClick={() => setShowNewForm(true)}>
              + New Codeprint
            </button>
          )}

          <div className="term-sidebar-codeprints">
            {codeprints.length === 0 && !showNewForm && (
              <div className="term-sidebar-empty">No codeprints yet</div>
            )}
            {codeprints.map((cp) => (
              <div
                key={cp.id}
                className={`term-sidebar-cp${hoveredId === cp.id ? ' hovered' : ''}`}
                onMouseEnter={() => setHoveredId(cp.id)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <div className="term-sidebar-cp-name">{cp.name}</div>
                <div className="term-sidebar-cp-cmd">{cp.command}</div>
                {hoveredId === cp.id && (
                  <div className="term-sidebar-cp-actions">
                    <button
                      className="term-sidebar-cp-btn"
                      title={hint('Paste into terminal')}
                      onClick={() => sendToTerminal(cp.command, false)}
                    >
                      Paste
                    </button>
                    <button
                      className="term-sidebar-cp-btn term-sidebar-cp-run"
                      title={hint('Paste and run')}
                      onClick={() => sendToTerminal(cp.command, true)}
                    >
                      Run
                    </button>
                    <button
                      className="term-sidebar-cp-del"
                      title={hint('Delete')}
                      onClick={() => deleteCodeprint(cp.id)}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {section === 'theme' && (
        <div className="term-sidebar-body term-sidebar-theme-list">
          {Object.keys(customThemes).length > 0 && (
            <>
              <div className="term-sidebar-group-label">Custom</div>
              {Object.entries(customThemes).map(([id, t]) => (
                <button
                  key={id}
                  className={`term-sidebar-theme-item${currentTheme === id ? ' active' : ''}`}
                  onClick={() => activeSessionId && setSessionTheme(activeSessionId, id)}
                  title={hint(t.name)}
                >
                  <div className="term-sidebar-theme-swatch" style={{ background: t.background }}>
                    <div style={{ width: '65%', height: 3, background: t.green, borderRadius: 1, marginBottom: 2 }} />
                    <div style={{ width: '45%', height: 3, background: t.foreground, borderRadius: 1, marginBottom: 2 }} />
                    <div style={{ width: '55%', height: 3, background: t.blue, borderRadius: 1 }} />
                  </div>
                  <span className="term-sidebar-theme-name">{t.name}</span>
                </button>
              ))}
              <div className="term-sidebar-group-label">Built-in</div>
            </>
          )}
          {Object.entries(THEMES).map(([id, t]) => (
            <button
              key={id}
              className={`term-sidebar-theme-item${currentTheme === id ? ' active' : ''}`}
              onClick={() => activeSessionId && setSessionTheme(activeSessionId, id)}
              title={hint(t.name)}
            >
              <div className="term-sidebar-theme-swatch" style={{ background: t.background }}>
                <div style={{ width: '65%', height: 3, background: t.green, borderRadius: 1, marginBottom: 2 }} />
                <div style={{ width: '45%', height: 3, background: t.foreground, borderRadius: 1, marginBottom: 2 }} />
                <div style={{ width: '55%', height: 3, background: t.blue, borderRadius: 1 }} />
              </div>
              <span className="term-sidebar-theme-name">{t.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
