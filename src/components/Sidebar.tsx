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
          <span className="nav-icon">&#128273;</span> Keychain
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
