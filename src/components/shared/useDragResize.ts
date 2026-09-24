/**
 * Dragging a divider: the bookkeeping, not the arithmetic.
 *
 * Two of these exist, for terminal panes and for the file list's columns, and
 * what they share is everything except what a delta means. Both need the
 * pointer to be able to leave the handle, which means listening on the window
 * rather than the element; both have to put the cursor and the text selection
 * back however the drag ends; and both are better off moving state once a
 * frame than once a mouse event, since every move reflows something.
 *
 * The caller says what a percentage of movement does. Nothing here knows
 * whether that is a pane, a column, or how far either may be pushed.
 */
export function useDragResize() {
  /**
   * Starts a drag. `width` is what a delta is measured against, so the caller
   * decides whether that is the row, the table or something else. `onDelta`
   * is called with the movement so far as a percentage of it, from where the
   * drag began rather than from the last event.
   */
  return function startDrag(
    e: React.MouseEvent,
    width: number,
    onDelta: (percent: number) => void,
  ) {
    e.preventDefault();
    // A pane's handle sits inside the pane, and dragging its edge should not
    // also count as clicking into it.
    e.stopPropagation();
    const startX = e.clientX;
    const against = width || 1;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    let frame = 0;

    function onMove(ev: MouseEvent) {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        onDelta(((ev.clientX - startX) / against) * 100);
      });
    }

    function onUp() {
      if (frame !== 0) cancelAnimationFrame(frame);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
}
