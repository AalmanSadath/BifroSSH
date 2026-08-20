import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Closes something when a click lands outside it.
 *
 * On `mousedown` rather than `click`, so a menu closes as the press begins
 * rather than waiting for the release, which is what makes a press-and-drag
 * onto a control behind it behave.
 *
 * The listener is only attached while `open`, so a page with several of these
 * on it is not running one handler per closed menu.
 */
export function useDismissOnOutside(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [ref, open, onClose]);
}
