import type { ReactNode } from 'react';

/**
 * The small "are you sure" box, five copies of which were byte-identical.
 *
 * Deliberately not built on `Modal`: this is a different widget, centred by
 * transform over a bare backdrop rather than a full dialog with a header, and
 * every use of it so far has been a destructive one.
 */
export default function ConfirmModal({
  question,
  hint,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: {
  question: ReactNode;
  /** A line under the question, for what the caller cannot undo. */
  hint?: ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="modal-overlay" onClick={onCancel} />
      <div className="kc-confirm-modal">
        <p>{question}</p>
        {hint && <p className="form-hint" style={{ margin: 0 }}>{hint}</p>}
        <div className="kc-confirm-actions">
          <button className="btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
          <button className="btn-danger btn-sm" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </>
  );
}
