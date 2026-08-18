import type { ReactNode } from 'react';

/**
 * The right-hand slide-over panel, with its backdrop and header.
 *
 * The `onContextMenu` guard was repeated on all six copies: a right-click
 * inside a drawer must not open the context menu of the panel behind it.
 */
export default function Drawer({
  title,
  /** The header's right-hand slot, in practice always the submit button. */
  action,
  className,
  onClose,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div
        className={`drawer${className ? ` ${className}` : ''}`}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        <div className="drawer-header">
          <button className="drawer-close" onClick={onClose}>✕</button>
          <span>{title}</span>
          {action ?? <span />}
        </div>
        {children}
      </div>
    </>
  );
}
