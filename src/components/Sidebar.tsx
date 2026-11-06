import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useAppStore } from '../store/appStore';
import { useHint } from './shared/useHint';
import { APP, BrandLogo, SETUP, WORK, currentPage, type NavItem } from './navItems';

/** The desktop's page list. Android lists the same pages on NavPage. */
export default function Sidebar() {
  const { activeTabId, setActiveTab, updateAvailable } = useAppStore();
  const [collapsed, setCollapsed] = useState(false);
  const hint = useHint();

  const current = currentPage(activeTabId);

  const button = ({ id, label, icon }: NavItem) => (
    <button
      key={id}
      className={`nav-btn ${current === id ? 'active' : ''}`}
      onClick={() => setActiveTab(id)}
      title={collapsed ? hint(label) : undefined}
    >
      <span className="nav-icon">{icon(20)}</span>
      {!collapsed && label}
      {id === 'settings' && updateAvailable && collapsed && <span className="dot dot-on sidebar-update-dot" />}
    </button>
  );

  return (
    <aside
      className={`sidebar${collapsed ? ' sidebar-collapsed' : ''}`}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="sidebar-top" data-tauri-drag-region>
        {!collapsed && <div className="sidebar-brand" data-tauri-drag-region>
          <BrandLogo size={28} />
          <span className="sidebar-brand-text" data-tauri-drag-region>BifroSSH</span>
        </div>}
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
        {WORK.map(button)}
        {/* Set up once and left alone, so they sit with the app's own
            settings rather than with the three you actually work in. */}
        <div className="sidebar-nav-setup">
          {SETUP.map(button)}
        </div>
      </nav>
      <nav className="sidebar-nav-bottom">
        {/* Expanded: a pill naming the version, which opens the release
            page. Collapsed: a dot on the Settings button, where the same
            news is spelled out under About. */}
        {updateAvailable && !collapsed && (
          <button
            className="sidebar-update"
            onClick={() => openUrl(updateAvailable.url).catch(() => {})}
            title={hint('Open the release page')}
          >
            <span className="dot dot-on" />
            v{updateAvailable.version} available
          </button>
        )}
        {APP.map(button)}
      </nav>
    </aside>
  );
}
