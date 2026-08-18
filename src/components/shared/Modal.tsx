import type { FormEvent, ReactNode } from 'react';

interface Props {
  title: ReactNode;
  /**
   * Rendered under the title. An array becomes one `.modal-subtitle` per entry
   * rather than one holding all of them, which keeps the gap between them;
   * falsy entries drop out so a conditional line can be written inline.
   */
  subtitle?: ReactNode | ReactNode[];
  /** Extra class on the dialog itself, beside `.modal`. */
  className?: string;
  /**
   * Dismissal. Leaving this out is what makes a modal blocking: the host key
   * prompt and the auth prompt both have a backend waiting on an answer, and
   * clicking the backdrop is not one.
   */
  onClose?: () => void;
  /** Present for a modal whose body is a form; the dialog then *is* the form. */
  onSubmit?: (e: FormEvent) => void;
  /** Raised above the panels' own overlays for the two blocking prompts. */
  zIndex?: number;
  children: ReactNode;
}

/**
 * The centred dialog shell: backdrop, panel, header.
 *
 * Six copies of this existed, and they had already drifted — four dismissed on
 * a backdrop click and two did not, with nothing to say which was intended.
 * Here the presence of `onClose` says it.
 */
export default function Modal({
  title,
  subtitle,
  className,
  onClose,
  onSubmit,
  zIndex,
  children,
}: Props) {
  const subtitles = (Array.isArray(subtitle) ? subtitle : [subtitle]).filter(Boolean);

  const body = (
    <>
      <div className="modal-header">
        <div>
          <h2>{title}</h2>
          {subtitles.map((s, i) => (
            <div key={i} className="modal-subtitle">{s}</div>
          ))}
        </div>
      </div>
      {children}
    </>
  );

  // Clicks inside the dialog reach the backdrop by bubbling, so they have to be
  // stopped there or every click in the modal would close it.
  const stop = onClose ? (e: React.MouseEvent) => e.stopPropagation() : undefined;
  const cls = `modal${className ? ` ${className}` : ''}`;

  return (
    <div className="modal-overlay" style={zIndex ? { zIndex } : undefined} onClick={onClose}>
      {onSubmit ? (
        <form className={cls} onClick={stop} onSubmit={onSubmit}>
          {body}
        </form>
      ) : (
        <div className={cls} onClick={stop}>
          {body}
        </div>
      )}
    </div>
  );
}
