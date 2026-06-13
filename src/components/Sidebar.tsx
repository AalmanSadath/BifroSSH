import { useState } from 'react';
import { useAppStore } from '../store/appStore';


const PANELS = ['hosts', 'sftp', 'keychain', 'settings', 'theme-editor'];

export default function Sidebar() {
  const { activeTabId, setActiveTab, settings } = useAppStore();
  const [collapsed, setCollapsed] = useState(false);
  const hint = (t: string) => settings.show_hover_hints ? t : undefined;

  const activePanel = PANELS.includes(activeTabId ?? '') ? activeTabId : null;

  return (
    <aside className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}>
      <div className="sidebar-top">
        <div className="sidebar-brand">
          <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 512 512" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <path d="M 110 390 L 110 200" strokeWidth="30"/>
            <path d="M 402 390 L 402 200" strokeWidth="30"/>
            <path d="M 110 200 Q 256 40 402 200" strokeWidth="30"/>
            <path d="M 174 254 L 254 296 L 174 338" strokeWidth="24"/>
            <path d="M 254 360 L 338 360" strokeWidth="24"/>
          </svg>
          {!collapsed && <span className="sidebar-brand-text">BifroSSH</span>}
        </div>
        <button className="sidebar-collapse-btn" onClick={() => setCollapsed(c => !c)} title={hint(collapsed ? 'Expand sidebar' : 'Collapse sidebar')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            {collapsed
              ? <><polyline points="9,18 15,12 9,6"/></>
              : <><polyline points="15,18 9,12 15,6"/></>
            }
          </svg>
        </button>
      </div>
      <nav className="sidebar-nav">
        <button
          className={`nav-btn ${activePanel === 'hosts' || activePanel === null ? 'active' : ''}`}
          onClick={() => setActiveTab('hosts')}
          title={collapsed ? 'Hosts' : undefined}
        >
          <span className="nav-icon">&#9707;</span>
          {!collapsed && 'Hosts'}
        </button>
        <button
          className={`nav-btn ${activePanel === 'sftp' ? 'active' : ''}`}
          onClick={() => setActiveTab('sftp')}
          title={collapsed ? 'SFTP' : undefined}
        >
          <span className="nav-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
              <path d="M9 14l2 2 4-4"/>
            </svg>
          </span>
          {!collapsed && 'SFTP'}
        </button>
        <button
          className={`nav-btn ${activePanel === 'keychain' ? 'active' : ''}`}
          onClick={() => setActiveTab('keychain')}
          title={collapsed ? 'Keychain' : undefined}
        >
          <span className="nav-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="7.5" cy="7.5" r="4.5"/>
              <path d="M10.5 10.5L21 21"/>
              <path d="M17 17l2-2"/>
              <path d="M19 15l2-2"/>
            </svg>
          </span>
          {!collapsed && 'Keychain'}
        </button>
      </nav>
      <nav className="sidebar-nav-bottom">
        <button
          className={`nav-btn ${activePanel === 'theme-editor' ? 'active' : ''}`}
          onClick={() => setActiveTab('theme-editor')}
          title={collapsed ? 'Theme Editor' : undefined}
        >
          <span className="nav-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a10 10 0 1 0 10 10c0-2.8-2.2-5-5-5h-1.6c-.9 0-1.6-.7-1.6-1.6 0-.4.2-.8.4-1.1.2-.3.4-.7.4-1.1C14.6 2.7 13.4 2 12 2z"/>
              <circle cx="7"  cy="10"  r="1.5" fill="currentColor" stroke="none"/>
              <circle cx="10" cy="7"   r="1.5" fill="currentColor" stroke="none"/>
              <circle cx="8"  cy="14.5" r="1.5" fill="currentColor" stroke="none"/>
              <circle cx="12" cy="16"  r="1.5" fill="currentColor" stroke="none"/>
            </svg>
          </span>
          {!collapsed && 'Theme Editor'}
        </button>
        <button
          className={`nav-btn ${activePanel === 'settings' ? 'active' : ''}`}
          onClick={() => setActiveTab('settings')}
          title={collapsed ? 'Settings' : undefined}
        >
          <span className="nav-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
            </svg>
          </span>
          {!collapsed && 'Settings'}
        </button>
      </nav>
    </aside>
  );
}
