/**
 * What the app binds to the keyboard, and how a binding is written down.
 *
 * A chord is a canonical string: modifiers in a fixed order, then the
 * `KeyboardEvent.code` of the key itself, as in `Ctrl+Shift+KeyL` or
 * `Ctrl+PageDown`. `code` rather than `key` so a binding survives a layout
 * change: on a French keyboard the key in the place of Q reports `KeyA`, and
 * the chord the user pressed is the one that comes back.
 *
 * Pure, so the table and the matching can be tested without a window.
 */

export type ActionId =
  | 'lock-vault'
  | 'next-tab'
  | 'prev-tab'
  | 'palette'
  | 'duplicate-tab'
  | 'toggle-broadcast'
  | 'local-shell'
  | 'close-tab'
  | 'select-tab-1'
  | 'select-tab-2'
  | 'select-tab-3'
  | 'select-tab-4'
  | 'select-tab-5'
  | 'select-tab-6'
  | 'select-tab-7'
  | 'select-tab-8'
  | 'select-tab-9'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'term-search'
  | 'term-copy'
  | 'term-paste';

export interface ShortcutAction {
  id: ActionId;
  label: string;
  /** What it does, shown under the label. */
  detail: string;
  group: 'Tabs' | 'Window' | 'Terminal';
  /**
   * Chords, comma-joined. Several because tab cycling answers to the two
   * pairs every terminal does, and taking one of them away would be a
   * regression for whoever uses it.
   */
  defaults: string;
}

/**
 * The bindable actions, in the order the editor lists them.
 *
 * Ctrl+W is deliberately not here: it is readline's delete-word and every
 * shell wants it, which is why closing a tab is Ctrl+Shift+W, as it is in
 * GNOME Terminal. Ctrl+F is left to the remote application for the same
 * reason.
 */
export const ACTIONS: ShortcutAction[] = [
  {
    id: 'next-tab',
    label: 'Next tab',
    detail: 'Moves along the strip, wrapping at the end.',
    group: 'Tabs',
    defaults: 'Ctrl+Tab,Ctrl+PageDown',
  },
  {
    id: 'prev-tab',
    label: 'Previous tab',
    detail: 'Moves back along the strip, wrapping at the start.',
    group: 'Tabs',
    defaults: 'Ctrl+Shift+Tab,Ctrl+PageUp',
  },
  {
    id: 'duplicate-tab',
    label: 'Duplicate tab',
    detail: 'Opens a second session on the current tab’s host.',
    group: 'Tabs',
    defaults: 'Ctrl+Shift+KeyT',
  },
  {
    id: 'close-tab',
    label: 'Close tab',
    detail: 'Disconnects the current session and closes its tab.',
    group: 'Tabs',
    defaults: 'Ctrl+Shift+KeyW',
  },
  {
    id: 'toggle-broadcast',
    label: 'Toggle broadcast',
    detail: 'Types into every broadcasting tab at once.',
    group: 'Tabs',
    defaults: 'Ctrl+Shift+KeyB',
  },
  {
    id: 'local-shell',
    label: 'Local shell',
    detail: 'Opens a tab with a shell on this computer.',
    group: 'Tabs',
    defaults: 'Ctrl+Shift+KeyN',
  },
  ...numberedTabs(),
  {
    id: 'palette',
    label: 'Command palette',
    detail: 'Opens the search over tabs, hosts and actions.',
    group: 'Window',
    defaults: 'Ctrl+KeyK',
  },
  {
    id: 'lock-vault',
    label: 'Lock vault',
    detail: 'Closes the vault at once; sessions keep running behind it.',
    group: 'Window',
    defaults: 'Ctrl+Shift+KeyL',
  },
  {
    id: 'zoom-in',
    label: 'Zoom in',
    detail: 'Makes this tab\u2019s text larger, leaving the others alone.',
    group: 'Terminal',
    defaults: 'Ctrl+Equal,Ctrl+NumpadAdd',
  },
  {
    id: 'zoom-out',
    label: 'Zoom out',
    detail: 'Makes this tab\u2019s text smaller.',
    group: 'Terminal',
    defaults: 'Ctrl+Minus,Ctrl+NumpadSubtract',
  },
  {
    id: 'zoom-reset',
    label: 'Reset zoom',
    detail: 'Puts this tab back on the size in Settings.',
    group: 'Terminal',
    defaults: 'Ctrl+Digit0',
  },
  {
    id: 'term-search',
    label: 'Search scrollback',
    detail: 'Opens the find bar over the terminal.',
    group: 'Terminal',
    defaults: 'Ctrl+Shift+KeyF',
  },
  {
    id: 'term-copy',
    label: 'Copy selection',
    detail: 'Copies the terminal selection.',
    group: 'Terminal',
    defaults: 'Ctrl+Shift+KeyC',
  },
  {
    id: 'term-paste',
    label: 'Paste',
    detail: 'Pastes the clipboard into the terminal.',
    group: 'Terminal',
    defaults: 'Ctrl+Shift+KeyV',
  },
];

/**
 * Ctrl+1 to Ctrl+9, one action each.
 *
 * Nine rather than one action taking an argument, because a binding is a
 * chord against an action id and nothing else; written out, each is
 * rebindable on its own. Nine is the last tab however many there are, which
 * is what every browser does.
 */
function numberedTabs(): ShortcutAction[] {
  return Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    return {
      id: `select-tab-${n}` as ActionId,
      label: n === 9 ? 'Last tab' : `Tab ${n}`,
      detail: n === 9 ? 'Selects the last tab in the strip.' : `Selects the ${ordinal(n)} tab in the strip.`,
      group: 'Tabs' as const,
      defaults: `Ctrl+Digit${n}`,
    };
  });
}

function ordinal(n: number): string {
  return ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'][n - 1];
}

/**
 * The tab a numbered action selects, given how many tabs there are, or null
 * when the strip is too short. The ninth is the last one.
 */
export function tabIndexFor(id: ActionId, count: number): number | null {
  const match = /^select-tab-([1-9])$/.exec(id);
  if (match === null || count === 0) return null;
  const n = Number(match[1]);
  if (n === 9) return count - 1;
  return n <= count ? n - 1 : null;
}

/** The terminal's own actions; the rest are matched on the window. */
export const TERMINAL_ACTIONS: ActionId[] = ['term-search', 'term-copy', 'term-paste'];

/**
 * The actions the window handler answers for. Matched there in the capture
 * phase, so a chord bound both here and in the terminal acts here.
 */
export const WINDOW_ACTIONS: ActionId[] = ACTIONS
  .map((a) => a.id)
  .filter((id) => !TERMINAL_ACTIONS.includes(id));

/** Modifier keys pressed on their own, which are not a chord. */
const BARE = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

/**
 * The chord a key event spells, or null when it spells nothing bindable.
 *
 * A key with no modifier is refused: every one of these has to live
 * alongside a terminal that wants the unmodified keyboard to itself.
 */
export function chordOf(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  if (!e.code || BARE.test(e.code)) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  if (parts.length === 0) return null;
  parts.push(e.code);
  return parts.join('+');
}

const KEY_LABELS: Record<string, string> = {
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Space: 'Space',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  NumpadAdd: 'Numpad +',
  NumpadSubtract: 'Numpad -',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/** A chord as a person reads it: `Ctrl+Shift+KeyL` becomes `Ctrl+Shift+L`. */
export function formatChord(chord: string): string {
  if (chord === '') return 'Unbound';
  const parts = chord.split('+');
  const key = parts.pop() ?? '';
  const label =
    KEY_LABELS[key] ??
    (key.startsWith('Key') ? key.slice(3) : key.startsWith('Digit') ? key.slice(5) : key);
  return [...parts, label].join('+');
}

/** Several chords, as the editor shows them. */
export function formatChords(chords: string[]): string {
  return chords.length === 0 ? 'Unbound' : chords.map(formatChord).join(' or ');
}

export type ShortcutMap = Record<ActionId, string[]>;

/**
 * The bindings in force.
 *
 * `overrides` holds only what the user changed, so a default corrected in a
 * later version reaches everyone who never touched it. An override of the
 * empty string means the action is unbound, which is how Ctrl+Shift+F is
 * handed back to the remote application.
 */
export function resolve(overrides: Record<string, string>): ShortcutMap {
  const map = {} as ShortcutMap;
  for (const action of ACTIONS) {
    const raw = overrides[action.id] ?? action.defaults;
    map[action.id] = raw.split(',').map((c) => c.trim()).filter((c) => c !== '');
  }
  return map;
}

/**
 * Which action a key event triggers, or null for none.
 *
 * `only` narrows the search to one surface: the terminal asks for its own
 * three, since the window handler has already had its turn in the capture
 * phase.
 */
export function actionFor(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  map: ShortcutMap,
  only?: ActionId[],
): ActionId | null {
  const chord = chordOf(e);
  if (chord === null) return null;
  for (const action of ACTIONS) {
    if (only && !only.includes(action.id)) continue;
    if (map[action.id].includes(chord)) return action.id;
  }
  return null;
}

/**
 * The action already holding `chord`, ignoring `exclude`, or null.
 *
 * Asked before a rebinding is written, so the user is told what they are
 * about to shadow rather than finding out when a key stops working.
 */
export function ownerOf(map: ShortcutMap, chord: string, exclude: ActionId): ActionId | null {
  for (const action of ACTIONS) {
    if (action.id === exclude) continue;
    if (map[action.id].includes(chord)) return action.id;
  }
  return null;
}

/**
 * Chords claimed by more than one action.
 *
 * Reported rather than refused: the window handler runs in the capture phase
 * and so always wins over the terminal's, and saying which one wins is more
 * use than forbidding the pair.
 */
export function conflictsIn(map: ShortcutMap): Map<string, ActionId[]> {
  const byChord = new Map<string, ActionId[]>();
  for (const action of ACTIONS) {
    for (const chord of map[action.id]) {
      byChord.set(chord, [...(byChord.get(chord) ?? []), action.id]);
    }
  }
  for (const [chord, ids] of byChord) {
    if (ids.length < 2) byChord.delete(chord);
  }
  return byChord;
}

/** The overrides with one action rebound, or back to its default. */
export function withBinding(
  overrides: Record<string, string>,
  id: ActionId,
  chord: string | null,
): Record<string, string> {
  const next = { ...overrides };
  if (chord === null) delete next[id];
  else next[id] = chord;
  return next;
}
