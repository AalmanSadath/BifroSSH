import type { ReactNode } from 'react';

/**
 * The app's pages, as the desktop sidebar and Android's menu page both list
 * them. One list, so the two cannot drift apart in order, name or glyph.
 */
export interface NavItem {
  id: string;
  label: string;
  /** The line under the name on Android's menu page. */
  summary: string;
  icon: (size: number) => ReactNode;
}

export interface NavGroup {
  /** The heading over the group on Android's menu page. */
  title: string;
  items: NavItem[];
}

function Glyph({ size, width = 2.2, children }: { size: number; width?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

/** The pages you work in. */
export const WORK: NavItem[] = [
  {
    id: 'hosts', label: 'Hosts', summary: 'Saved servers and quick connect',
    icon: (s) => <Glyph size={s}>
      <rect x="2" y="8" width="20" height="4" rx="1.5"/>
      <rect x="2" y="15" width="20" height="4" rx="1.5"/>
      <line x1="6" y1="10" x2="6.01" y2="10"/>
      <line x1="6" y1="17" x2="6.01" y2="17"/>
    </Glyph>,
  },
  {
    id: 'sftp', label: 'SFTP', summary: 'Browse and transfer files',
    icon: (s) => <Glyph size={s}>
      <path d="M3 8a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"/>
      <path d="M9 14l2 2 4-4"/>
    </Glyph>,
  },
  {
    id: 'containers', label: 'Containers', summary: 'Containers running on your hosts',
    icon: (s) => <Glyph size={s}>
      <path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/>
      <path d="M3 7l9 5 9-5"/>
      <path d="M12 12v10"/>
    </Glyph>,
  },
  {
    id: 'portforwarding', label: 'Port Forwarding', summary: 'Local, remote and SOCKS tunnels',
    icon: (s) => <Glyph size={s}>
      <path d="M5 12h14"/>
      <path d="M15 7l5 5-5 5"/>
      <path d="M3 6v12"/>
    </Glyph>,
  },
];

/** Set up once and left alone. */
export const SETUP: NavItem[] = [
  {
    id: 'keychain', label: 'Keychain', summary: 'Keys and passwords',
    icon: (s) => <Glyph size={s}>
      <circle cx="7.5" cy="7.5" r="4.5"/>
      <path d="M10.5 10.5L21 21"/>
      <path d="M17 17l2-2"/>
      <path d="M19 15l2-2"/>
    </Glyph>,
  },
  {
    id: 'knownhosts', label: 'Known Hosts', summary: 'Trusted server fingerprints',
    icon: (s) => <Glyph size={s}>
      <path d="M12 3l7 3v5.5c0 4.2-2.9 7.6-7 8.5-4.1-.9-7-4.3-7-8.5V6z"/>
      <path d="M9 12l2 2 4-4"/>
    </Glyph>,
  },
  {
    id: 'recordings', label: 'Recordings', summary: 'Replay recorded sessions',
    icon: (s) => <Glyph size={s}>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5"/>
      <path d="M10 9l5 3-5 3z"/>
    </Glyph>,
  },
];

/** The app's own pages. */
export const APP: NavItem[] = [
  {
    id: 'theme-editor', label: 'Theme Editor', summary: 'Build terminal colour themes',
    icon: (s) => <Glyph size={s} width={2}>
      <path d="M12 2a10 10 0 1 0 10 10c0-2.8-2.2-5-5-5h-1.6c-.9 0-1.6-.7-1.6-1.6 0-.4.2-.8.4-1.1.2-.3.4-.7.4-1.1C14.6 2.7 13.4 2 12 2z"/>
      <circle cx="7" cy="10" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="10" cy="7" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="8" cy="14.5" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none"/>
    </Glyph>,
  },
  {
    id: 'settings', label: 'Settings', summary: 'Preferences and app info',
    icon: (s) => <Glyph size={s}>
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
    </Glyph>,
  },
];

/** The app's mark: the bridge over a prompt. */
export function BrandLogo({ size }: { size: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 512 512" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M 110 390 L 110 200" strokeWidth="30"/>
      <path d="M 402 390 L 402 200" strokeWidth="30"/>
      <path d="M 110 200 Q 256 40 402 200" strokeWidth="30"/>
      <path d="M 174 254 L 254 296 L 174 338" strokeWidth="24"/>
      <path d="M 254 360 L 338 360" strokeWidth="24"/>
    </svg>
  );
}

export const NAV_GROUPS: NavGroup[] = [
  { title: 'Work', items: WORK },
  { title: 'Setup', items: SETUP },
  { title: 'App', items: APP },
];

const ITEMS = new Map(NAV_GROUPS.flatMap((g) => g.items.map((i) => [i.id, i] as const)));
const PANELS = new Set(ITEMS.keys());

/** A page's name, for the top row on a phone. */
export function pageLabel(id: string): string {
  return ITEMS.get(id)?.label ?? '';
}

/**
 * The page the nav marks as current. A session tab, or nothing, counts as
 * Hosts, which is where the sessions are started from.
 */
export function currentPage(activeTabId: string | null): string {
  return activeTabId && PANELS.has(activeTabId) ? activeTabId : 'hosts';
}
