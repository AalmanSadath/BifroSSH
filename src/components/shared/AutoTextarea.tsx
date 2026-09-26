import { useLayoutEffect, useRef } from 'react';

interface Props {
  value: string;
  onChange: (text: string) => void;
  className?: string;
  placeholder?: string;
  /** The height when empty or short, in rows. */
  rows?: number;
}

/**
 * A textarea as tall as its text, so all of it shows without scrolling
 * inside the box: a key or a certificate is read whole, not a few lines of
 * it at a time.
 */
export default function AutoTextarea({ value, onChange, className, placeholder, rows = 2 }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight leaves out the border, which box-sizing puts inside the height.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className={`${className ?? ''} auto-textarea`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={rows}
      spellCheck={false}
      placeholder={placeholder}
    />
  );
}
