import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from './store/appStore';
import Sidebar from './components/Sidebar';
import TerminalView from './components/TerminalView';
import HostsPanel from './components/HostsPanel';
import KeychainPanel from './components/KeychainPanel';
import SettingsPanel from './components/SettingsPanel';

export default function App() {
  const { loadAll, sessions, activeTabId, setActiveTab, removeSession } = useAppStore();

  useEffect(() => {
    loadAll();
  }, []);

  function handleCloseTab(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation();
    invoke('ssh_disconnect', { sessionId }).catch(() => {});
    removeSession(sessionId);
  }

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        {sessions.length > 0 && (
          <div className="tab-bar">
            {sessions.map((s) => (
              <div
                key={s.session_id}
                className={`tab ${activeTabId === s.session_id ? 'tab-active' : ''}`}
                onClick={() => setActiveTab(s.session_id)}
              >
                <span className="tab-title">{s.server_name}</span>
                <button className="tab-close" onClick={(e) => handleCloseTab(s.session_id, e)}>&#10005;</button>
              </div>
            ))}
          </div>
        )}

        <div className="content">
          {sessions.map((s) => (
            <TerminalView
              key={s.session_id}
              sessionId={s.session_id}
              serverId={s.server_id}
              active={activeTabId === s.session_id}
            />
          ))}

          {(activeTabId === 'hosts' || activeTabId === null) && <HostsPanel />}
          {activeTabId === 'keychain' && <KeychainPanel />}
          {activeTabId === 'settings' && <SettingsPanel />}
        </div>
      </div>
    </div>
  );
}
