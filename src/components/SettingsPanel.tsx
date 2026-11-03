import { useAppStore } from '../store/appStore';
import AppearanceSection from './settings/AppearanceSection';
import TerminalSection from './settings/TerminalSection';
import ShortcutsSection from './settings/ShortcutsSection';
import ConnectionSection from './settings/ConnectionSection';
import SecuritySection from './settings/SecuritySection';
import DataSection from './settings/DataSection';
import AboutSection from './settings/AboutSection';
import type { SettingsSection } from '../types';
import { isAndroid } from '../platform';
import { useEffect, type ReactNode } from 'react';
import { useBackClose } from '../backStack';
import {
  ArrowLeftIcon, ChevronRightIcon, DatabaseIcon, InfoIcon, PaletteIcon, PlugIcon, ShieldIcon, TerminalIcon,
} from './shared/icons';

interface Category {
  id: SettingsSection;
  label: string;
  /** Drawn on Android's list of categories; the desktop rail is text only. */
  icon: ReactNode;
}

const ICON = 22;

const CATEGORIES: Category[] = [
  { id: 'appearance', label: 'Appearance', icon: <PaletteIcon size={ICON} /> },
  { id: 'terminal', label: 'Terminal', icon: <TerminalIcon size={ICON} /> },
  // A touch screen has no keys to bind.
  ...(isAndroid ? [] : [{ id: 'shortcuts' as const, label: 'Shortcuts', icon: null }]),
  { id: 'connection', label: 'Connection', icon: <PlugIcon size={ICON} /> },
  { id: 'security', label: 'Security', icon: <ShieldIcon size={ICON} /> },
  { id: 'data', label: 'Data', icon: <DatabaseIcon size={ICON} /> },
  { id: 'about', label: 'About', icon: <InfoIcon size={ICON} /> },
];

/** Android's list, in blocks: what you set, then what the app tells you. */
const CARD_GROUPS: SettingsSection[][] = [
  ['appearance', 'terminal', 'connection', 'security', 'data'],
  ['about'],
];

function SectionBody({ section }: { section: SettingsSection }) {
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  switch (section) {
    case 'appearance': return <AppearanceSection />;
    case 'terminal': return <TerminalSection />;
    case 'shortcuts': return <ShortcutsSection />;
    case 'connection': return <ConnectionSection />;
    case 'security': return <SecuritySection setActiveTab={setActiveTab} />;
    case 'data': return <DataSection />;
    case 'about': return <AboutSection />;
  }
}

/**
 * Android: a list of categories as cards, each opening on a page of its own.
 *
 * The rail wrapped into a row of chips above the controls on a phone, which
 * left the controls a screen further down. The back arrow and Back both
 * return to the list, and leaving Settings forgets the open category, so the
 * drawer's Settings always arrives at the list.
 */
function AndroidSettings() {
  const { settingsSection, openSettings, closeSettingsSection } = useAppStore();
  useBackClose(settingsSection ? closeSettingsSection : undefined);
  useEffect(() => closeSettingsSection, [closeSettingsSection]);

  const current = CATEGORIES.find((c) => c.id === settingsSection);
  if (current) {
    return (
      <div className="panel settings-panel settings-panel-android">
        <div className="settings-subpage-head">
          <button className="settings-back" aria-label="Back" onClick={closeSettingsSection}>
            <ArrowLeftIcon size={22} />
          </button>
          <div className="panel-title">{current.label}</div>
        </div>
        <div className="settings-body">
          <SectionBody section={current.id} />
        </div>
      </div>
    );
  }

  return (
    <div className="panel settings-panel">
      <div className="panel-title">Settings</div>
      {CARD_GROUPS.map((group) => (
        <div key={group[0]} className="settings-cards">
          {group.map((id) => {
            const c = CATEGORIES.find((x) => x.id === id)!;
            return (
              <button key={id} className="settings-card" onClick={() => openSettings(id)}>
                <span className="settings-card-icon">{c.icon}</span>
                <span className="settings-card-label">{c.label}</span>
                <span className="settings-card-chevron"><ChevronRightIcon size={20} /></span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * One category at a time, chosen from the rail.
 *
 * This was a single scroll of ten sections in no particular order, with the
 * terminal's colours filed under the app's appearance and a section holding
 * one checkbox. Each category now lives in its own file under `settings/`,
 * which is also what gives the shortcut editor room to be a table.
 */
export default function SettingsPanel() {
  if (isAndroid) return <AndroidSettings />;
  return <DesktopSettings />;
}

function DesktopSettings() {
  const { settingsSection: chosen, openSettings } = useAppStore();
  const settingsSection = chosen ?? 'appearance';

  return (
    <div className="panel settings-panel settings-panel-desktop">
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
          <SectionBody section={settingsSection} />
        </div>
      </div>
    </div>
  );
}
