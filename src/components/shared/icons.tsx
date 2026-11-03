import type { ReactNode } from 'react';

/**
 * Icons drawn in more than one place.
 *
 * The edit pencil was inlined at four sites and had already drifted: two drew
 * it at strokeWidth 2 and two at 2.2, and the two halves of the path were
 * spelled with and without spaces in the arc flags. Nobody chose that.
 */

/** Pencil-over-page: opens the thing it sits on for editing. */
export function EditIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

/** Padlock: this needs a login to use. */
export function LockIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Lined page: this record carries notes. */
export function NoteIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </svg>
  );
}

/** The stroke style every icon here shares, around its own paths. */
function Stroke({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

/** Painter's palette: how the app looks. */
export function PaletteIcon({ size = 15 }: { size?: number }) {
  return (
    <Stroke size={size}>
      <path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.8-.5-1.2-.3-.3-.4-.7-.4-1.1 0-.9.7-1.6 1.6-1.6H16a5 5 0 0 0 5-5c0-4.1-4-7.4-9-7.4z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10" cy="7" r="1" />
      <circle cx="14.5" cy="7" r="1" />
      <circle cx="17" cy="11" r="1" />
    </Stroke>
  );
}

/** A prompt: the terminal. */
export function TerminalIcon({ size = 15 }: { size?: number }) {
  return (
    <Stroke size={size}>
      <path d="M4 17l6-5-6-5" />
      <path d="M12 19h8" />
    </Stroke>
  );
}

/** A plug: connections. */
export function PlugIcon({ size = 15 }: { size?: number }) {
  return (
    <Stroke size={size}>
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M6 8h12v4a6 6 0 0 1-12 0z" />
      <path d="M12 18v4" />
    </Stroke>
  );
}

/** A shield: security. */
export function ShieldIcon({ size = 15 }: { size?: number }) {
  return (
    <Stroke size={size}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </Stroke>
  );
}

/** A stack of disks: stored data. */
export function DatabaseIcon({ size = 15 }: { size?: number }) {
  return (
    <Stroke size={size}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </Stroke>
  );
}

/** An "i" in a circle: about. */
export function InfoIcon({ size = 15 }: { size?: number }) {
  return (
    <Stroke size={size}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Stroke>
  );
}

/** Points on to a page further in. */
export function ChevronRightIcon({ size = 15 }: { size?: number }) {
  return (
    <Stroke size={size}>
      <path d="M9 18l6-6-6-6" />
    </Stroke>
  );
}

/** Back to the page this one was opened from. */
export function ArrowLeftIcon({ size = 15 }: { size?: number }) {
  return (
    <Stroke size={size}>
      <path d="M19 12H5" />
      <path d="M12 19l-7-7 7-7" />
    </Stroke>
  );
}
