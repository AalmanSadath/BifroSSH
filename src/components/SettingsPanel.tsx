import { useAppStore } from '../store/appStore';
import AppearanceSection from './settings/AppearanceSection';
import TerminalSection from './settings/TerminalSection';
import ShortcutsSection from './settings/ShortcutsSection';
import ConnectionSection from './settings/ConnectionSection';
import SecuritySection from './settings/SecuritySection';
import DataSection from './settings/DataSection';
import AboutSection from './settings/AboutSection';
import type { SettingsSection } from '../types';

const CATEGORIES: { id: SettingsSection; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'connection', label: 'Connection' },
  { id: 'security', label: 'Security' },
  { id: 'data', label: 'Data' },
  { id: 'about', label: 'About' },
];

/**
 * One category at a time, chosen from the rail.
 *
 * This was a single scroll of ten sections in no particular order, with the
 * terminal's colours filed under the app's appearance and a section holding
 * one checkbox. Each category now lives in its own file under `settings/`,
 * which is also what gives the shortcut editor room to be a table.
 */
export default function SettingsPanel() {
  const { settingsSection, openSettings, setActiveTab } = useAppStore();

  return (
    <div className="panel settings-panel">
      <div className="panel-title">Settings</div>
      <div className="settings-layout">
        <nav className="settings-rail">
          {CATEGORIES.map(({ id, label }) => (
            <button
              key={id}
              className={`settings-rail-item${settingsSection === id ? ' active' : ''}`}
              onClick={() => openSettings(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          {settingsSection === 'appearance' && <AppearanceSection />}
          {settingsSection === 'terminal' && <TerminalSection />}
          {settingsSection === 'shortcuts' && <ShortcutsSection />}
          {settingsSection === 'connection' && <ConnectionSection />}
          {settingsSection === 'security' && <SecuritySection setActiveTab={setActiveTab} />}
          {settingsSection === 'data' && <DataSection />}
          {settingsSection === 'about' && <AboutSection />}
        </div>
      </div>
    </div>
  );
}
