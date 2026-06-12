import React from 'react';

export const OS_OPTIONS = [
  { value: 'linux',       label: 'Linux'        },
  { value: 'ubuntu',      label: 'Ubuntu'       },
  { value: 'debian',      label: 'Debian'       },
  { value: 'arch',        label: 'Arch'         },
  { value: 'fedora',      label: 'Fedora'       },
  { value: 'macos',       label: 'macOS'        },
  { value: 'windows',     label: 'Windows'      },
  { value: 'freebsd',     label: 'FreeBSD'      },
  { value: 'raspberrypi', label: 'Raspberry Pi' },
  { value: 'server',      label: 'Server'       },
];

function Linux() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none">
      <ellipse cx="12" cy="16" rx="7" ry="7" fill="currentColor"/>
      <ellipse cx="12" cy="17" rx="4" ry="5" fill="white" opacity="0.18"/>
      <circle cx="12" cy="7" r="5" fill="currentColor"/>
      <circle cx="9.8" cy="6" r="1.8" fill="white"/>
      <circle cx="14.2" cy="6" r="1.8" fill="white"/>
      <circle cx="10.1" cy="6.3" r="0.8" fill="#1a1a2e"/>
      <circle cx="14.5" cy="6.3" r="0.8" fill="#1a1a2e"/>
      <path d="M10.5 8.8 Q12 10.2 13.5 8.8" stroke="#f97316" strokeWidth="1.6" fill="none" strokeLinecap="round"/>
      <path d="M9 22 L7.5 23.5 L11 23.5Z" fill="#f97316"/>
      <path d="M15 22 L13.5 23.5 L17 23.5Z" fill="#f97316"/>
    </svg>
  );
}

function Ubuntu() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5"/>
      <circle cx="12" cy="3.2" r="2.8" fill="currentColor"/>
      <circle cx="4.4" cy="16.6" r="2.8" fill="currentColor"/>
      <circle cx="19.6" cy="16.6" r="2.8" fill="currentColor"/>
    </svg>
  );
}

function Debian() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%">
      <path d="M12 2 A10 10 0 1 1 4.5 18.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
      <path d="M13 7 A5.5 5.5 0 1 0 8.5 17" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

function Arch() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none">
      <path d="M12 2 L22 22 L2 22 Z" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" fill="none"/>
      <path d="M12 7 L18.5 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      <path d="M12 7 L5.5 21" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function Fedora() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none">
      {/* F shape with infinity loop */}
      <circle cx="14" cy="10" r="6" stroke="currentColor" strokeWidth="2.5" fill="none"/>
      <path d="M14 4 L14 20" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
      <path d="M8 10 L14 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

function MacOS() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">
      <path d="M14 3 Q16 1 18 2.5 Q16 4.5 14 3Z"/>
      <path d="M8.5 7 C5.5 7 3 10 3 13.5 C3 18.5 6.5 23 10 23 C11 23 11.5 22.5 12 22.5 C12.5 22.5 13 23 14 23 C17.5 23 21 18.5 21 13.5 C21 10 18.5 7 15.5 7 C14 7 13 8 12 8 C11 8 10 7 8.5 7Z"/>
    </svg>
  );
}

function Windows() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%">
      <rect x="2.5" y="2.5" width="9"  height="9"  rx="1.5" fill="#f35325"/>
      <rect x="12.5" y="2.5" width="9" height="9"  rx="1.5" fill="#81bc06"/>
      <rect x="2.5" y="12.5" width="9" height="9"  rx="1.5" fill="#ffba08"/>
      <rect x="12.5" y="12.5" width="9" height="9" rx="1.5" fill="#05a6f0"/>
    </svg>
  );
}

function FreeBSD() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">
      {/* Left horn */}
      <path d="M8 9 L3.5 2 L9.5 7Z"/>
      {/* Right horn */}
      <path d="M16 9 L20.5 2 L14.5 7Z"/>
      {/* Head/body */}
      <circle cx="12" cy="13" r="7"/>
      {/* Eyes */}
      <circle cx="9.5" cy="12" r="1.5" fill="#c00"/>
      <circle cx="14.5" cy="12" r="1.5" fill="#c00"/>
      {/* Tail */}
      <path d="M12 20 Q8 22 10 24 Q12 22 15 23 Q13 21 12 20Z"/>
    </svg>
  );
}

function RaspberryPi() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor">
      {/* Leaves */}
      <path d="M12 4.5 Q9 1.5 7 3 Q9 5.5 12 4.5Z"/>
      <path d="M12 4.5 Q15 1.5 17 3 Q15 5.5 12 4.5Z"/>
      {/* Raspberry drupes */}
      <circle cx="9"  cy="8.5" r="2.6"/>
      <circle cx="15" cy="8.5" r="2.6"/>
      <circle cx="7"  cy="13"  r="2.6"/>
      <circle cx="12" cy="12"  r="2.6"/>
      <circle cx="17" cy="13"  r="2.6"/>
      <circle cx="9"  cy="17.5" r="2.6"/>
      <circle cx="15" cy="17.5" r="2.6"/>
    </svg>
  );
}

function GenericServer() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" fill="none">
      <rect x="2" y="3"   width="20" height="5.5" rx="1.5" fill="currentColor" opacity="0.9"/>
      <rect x="2" y="9.5" width="20" height="5.5" rx="1.5" fill="currentColor" opacity="0.7"/>
      <rect x="2" y="16"  width="20" height="5.5" rx="1.5" fill="currentColor" opacity="0.5"/>
      <circle cx="18.5" cy="5.75"  r="1.2" fill="var(--bg-dark)"/>
      <circle cx="18.5" cy="12.25" r="1.2" fill="var(--bg-dark)"/>
      <circle cx="18.5" cy="18.75" r="1.2" fill="var(--bg-dark)"/>
      <rect x="4" y="5"    width="8" height="1.5" rx="0.75" fill="var(--bg-dark)" opacity="0.5"/>
      <rect x="4" y="11.5" width="8" height="1.5" rx="0.75" fill="var(--bg-dark)" opacity="0.5"/>
      <rect x="4" y="18"   width="8" height="1.5" rx="0.75" fill="var(--bg-dark)" opacity="0.5"/>
    </svg>
  );
}

const ICON_MAP: Record<string, () => React.ReactElement> = {
  linux:       Linux,
  ubuntu:      Ubuntu,
  debian:      Debian,
  arch:        Arch,
  fedora:      Fedora,
  macos:       MacOS,
  windows:     Windows,
  freebsd:     FreeBSD,
  raspberrypi: RaspberryPi,
  server:      GenericServer,
};

interface Props {
  os: string;
  size?: number;
}

export default function OsIcon({ os, size = 24 }: Props) {
  const IconComp = (os && ICON_MAP[os]) ? ICON_MAP[os] : GenericServer;
  return (
    <span style={{ display: 'inline-flex', width: size, height: size, flexShrink: 0 }}>
      <IconComp />
    </span>
  );
}
