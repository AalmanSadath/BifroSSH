import { useAppStore } from '../store/appStore';
import { useBackClose } from '../backStack';
import { ArrowLeftIcon, ChevronRightIcon } from './shared/icons';
import { BrandLogo, NAV_GROUPS, currentPage } from './navItems';

interface Props {
  onClose: () => void;
}

/**
 * Android's list of the app's pages, a page of its own opened from the top
 * row's menu button. It replaced a drawer that slid the desktop sidebar over
 * the page.
 *
 * It lies over the app rather than being a page the app switches to, so the
 * screen it was opened from stays as it was underneath, and Back, the arrow
 * or the edge swipe, returns to exactly that.
 */
export default function NavPage({ onClose }: Props) {
  const { activeTabId, setActiveTab, updateAvailable } = useAppStore();
  useBackClose(onClose);
  const current = currentPage(activeTabId);

  return (
    <div className="nav-page">
      <div className="panel settings-panel">
        <div className="settings-subpage-head">
          <button className="round-icon-btn" aria-label="Back" onClick={onClose}>
            <ArrowLeftIcon size={22} />
          </button>
          <div className="nav-page-brand">
            <BrandLogo size={26} />
            <span className="panel-title">BifroSSH</span>
          </div>
        </div>
        {NAV_GROUPS.map((group) => (
          <section key={group.title} className="settings-cards">
            <div className="settings-cards-title">{group.title}</div>
            {group.items.map(({ id, label, summary, icon }) => {
              const update = id === 'settings' && updateAvailable;
              return (
                <button
                  key={id}
                  className={`settings-card${current === id ? ' settings-card-current' : ''}`}
                  onClick={() => { setActiveTab(id); onClose(); }}
                >
                  <span className="settings-card-icon">{icon(20)}</span>
                  <span className="settings-card-text">
                    <span className="settings-card-label">{label}</span>
                    <span className={`settings-card-summary${update ? ' settings-card-summary-news' : ''}`}>
                      {update ? `v${update.version} available` : summary}
                    </span>
                  </span>
                  <span className="settings-card-chevron"><ChevronRightIcon size={18} /></span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
