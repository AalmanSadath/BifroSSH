import { useAppStore } from '../store/appStore';

const PANELS = ['hosts', 'sftp', 'keychain', 'settings', 'theme-editor'];

export default function Sidebar() {
  const { activeTabId, setActiveTab } = useAppStore();

  const activePanel = PANELS.includes(activeTabId ?? '') ? activeTabId : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 512 512" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 110 390 L 110 200" strokeWidth="30"/>
            <path d="M 402 390 L 402 200" strokeWidth="30"/>
            <path d="M 110 200 Q 256 40 402 200" strokeWidth="30"/>
            <path d="M 174 254 L 254 296 L 174 338" strokeWidth="24"/>
            <path d="M 254 360 L 338 360" strokeWidth="24"/>
          </svg>
          BifroSSH
        </div>
      </div>
      <nav className="sidebar-nav">
        <button
          className={`nav-btn ${activePanel === 'hosts' || activePanel === null ? 'active' : ''}`}
          onClick={() => setActiveTab('hosts')}
        >
          <span className="nav-icon">&#9707;</span> Hosts
        </button>
        <button
          className={`nav-btn ${activePanel === 'sftp' ? 'active' : ''}`}
          onClick={() => setActiveTab('sftp')}
        >
          <span className="nav-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
              <path d="M9 14l2 2 4-4"/>
            </svg>
          </span> SFTP
        </button>
        <button
          className={`nav-btn ${activePanel === 'keychain' ? 'active' : ''}`}
          onClick={() => setActiveTab('keychain')}
        >
          <span className="nav-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7.5" cy="7.5" r="4.5"/>
              <path d="M10.5 10.5L21 21"/>
              <path d="M17 17l2-2"/>
              <path d="M19 15l2-2"/>
            </svg>
          </span> Keychain
        </button>
      </nav>
      <nav className="sidebar-nav-bottom">
        <button
          className={`nav-btn ${activePanel === 'theme-editor' ? 'active' : ''}`}
          onClick={() => setActiveTab('theme-editor')}
        >
          <span className="nav-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="13.5" cy="6.5" r="2.5"/>
              <circle cx="19" cy="14" r="2.5"/>
              <circle cx="6" cy="14" r="2.5"/>
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.6-.7 1.6-1.6 0-.4-.2-.8-.4-1.1-.2-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16c2.8 0 5-2.2 5-5 0-4.4-4-8-9-8z"/>
            </svg>
          </span> Theme Editor
        </button>
        <button
          className={`nav-btn ${activePanel === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <span className="nav-icon">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </span> Settings
        </button>
      </nav>
    </aside>
  );
}
