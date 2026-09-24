interface Props {
  /** The line at the top, in the panel's dialog voice: a statement or a question. */
  title: string;
  /** Escape, which every dialog here reads as "I am done with this". */
  onEscape: () => void;
  /** A second class for the dialog box, where one wants its own width. */
  className?: string;
  children: React.ReactNode;
}

/**
 * The shell every SFTP dialog is drawn in: an overlay, a box, a title, and
 * whatever the dialog itself has to say.
 *
 * Five of these were written out by hand, and the one that was written last
 * was the one that forgot Escape. The shell carries the key, and carries the
 * focus that lets the key arrive: the handler sits on a div, so without
 * something focused inside the dialog the event goes to the document instead
 * and nothing happens. The dialog takes focus on mount unless a child has
 * already claimed it with autoFocus.
 *
 * None of these closes on a click outside, and none starts here: an answer
 * given by clicking past the question is not an answer.
 */
export default function SftpDialog({ title, onEscape, className, children }: Props) {
  return (
    <div
      className="sftp-confirm-overlay"
      onKeyDown={(e) => { if (e.key === 'Escape') onEscape(); }}
    >
      <div
        className={`sftp-confirm-dialog${className ? ` ${className}` : ''}`}
        tabIndex={-1}
        ref={(el) => {
          if (el && !el.contains(document.activeElement)) el.focus();
        }}
      >
        <p className="sftp-confirm-title">{title}</p>
        {children}
      </div>
    </div>
  );
}
