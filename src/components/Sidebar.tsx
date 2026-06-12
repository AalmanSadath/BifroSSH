import { useAppStore } from '../store/appStore';

const PANELS = ['hosts', 'keychain', 'settings'];

export default function Sidebar() {
  const { activeTabId, setActiveTab } = useAppStore();

  const activePanel = PANELS.includes(activeTabId ?? '') ? activeTabId : null;

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="sidebar-brand">BifroSSH</div>
      </div>
      <nav className="sidebar-nav">
        <button
          className={`nav-btn ${activePanel === 'hosts' || activePanel === null ? 'active' : ''}`}
          onClick={() => setActiveTab('hosts')}
        >
          <span className="nav-icon">&#9707;</span> Hosts
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
        <button
          className={`nav-btn ${activePanel === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          <span className="nav-icon">&#9881;</span> Settings
        </button>
      </nav>
    </aside>
  );
}
