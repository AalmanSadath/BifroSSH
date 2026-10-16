import type { Slice } from '../types';

/** Panes side by side before the terminals stop being useful. */
const MAX_SPLIT = 4;

/** The group without `tabId`; a group of one is no group. */
export function pruneSplit(group: string[], tabId: string): string[] {
  const rest = group.filter((id) => id !== tabId);
  return rest.length > 1 ? rest : [];
}

export interface SplitsSlice {
  /**
   * Tabs shown side by side, in strip order; empty when nothing is split.
   * The view is split whenever the active tab is one of them, and the
   * active tab is the focused pane. A tab outside the group shows alone
   * and leaves the group be, so coming back restores the split.
   */
  splitGroup: string[];
  /** Puts `dropped` beside `anchor`, starting a group from the anchor if there is none. */
  splitWith: (anchorTabId: string, droppedTabId: string) => void;
  unsplit: (tabId: string) => void;

  /**
   * Pane widths as percentages, parallel to `splitGroup`; empty means the
   * panes share the row evenly. Cleared whenever the group changes shape,
   * since widths belong to one set of panes and not to another. In memory
   * only, as the group itself is.
   */
  splitWidths: number[];
  setSplitWidths: (widths: number[]) => void;
}

export const createSplitsSlice: Slice<SplitsSlice> = (set) => ({
  splitGroup: [],
  splitWidths: [],

  splitWith: (anchorTabId, droppedTabId) =>
    set((s) => {
      if (anchorTabId === droppedTabId) return {};
      // A tab in a window of its own has no terminal here to put beside another.
      const ids = new Set(s.sessions.filter((t) => !t.detached).map((t) => t.tab_id));
      if (!ids.has(anchorTabId) || !ids.has(droppedTabId)) return {};
      const base = s.splitGroup.includes(anchorTabId) ? s.splitGroup : [anchorTabId];
      if (base.includes(droppedTabId) || base.length >= MAX_SPLIT) return {};
      const members = new Set([...base, droppedTabId]);
      // Strip order, so panes read the way the tabs do. The widths go: a
      // pane joining the row makes every old share the wrong size.
      return {
        splitGroup: s.sessions.map((t) => t.tab_id).filter((id) => members.has(id)),
        splitWidths: [],
      };
    }),

  unsplit: (tabId) => set((s) => ({ splitGroup: pruneSplit(s.splitGroup, tabId), splitWidths: [] })),

  setSplitWidths: (widths) => set({ splitWidths: widths }),
});
