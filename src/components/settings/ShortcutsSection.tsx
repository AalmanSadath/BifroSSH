import { useEffect, useState } from 'react';
import { useAppStore, reportFailure } from '../../store/appStore';
import {
  ACTIONS,
  TERMINAL_ACTIONS,
  chordOf,
  conflictsIn,
  ownerOf,
  formatChord,
  formatChords,
  resolve,
  withBinding,
  type ActionId,
  type ShortcutAction,
} from '../../shortcuts';

const GROUPS: ShortcutAction['group'][] = ['Tabs', 'Window', 'Terminal'];

/** Rebinding the chords in `shortcuts.ts`; the table there is the contract. */
export default function ShortcutsSection() {
  const { settings, saveSettings } = useAppStore();
  const overrides = settings.shortcuts;
  const map = resolve(overrides);
  const conflicts = conflictsIn(map);
  const [recording, setRecording] = useState<ActionId | null>(null);
  // A chord the user pressed that something else already answers to. Held
  // until they say which action should keep it.
  const [clash, setClash] = useState<{ id: ActionId; chord: string; other: ActionId } | null>(null);

  function write(next: Record<string, string>) {
    saveSettings({ ...settings, shortcuts: next }).catch(reportFailure);
  }

  /** Binds the chord, after the caller has settled any clash. */
  function bind(id: ActionId, chord: string) {
    write(withBinding(overrides, id, chord));
  }

  // While recording, the keyboard belongs to this row: the chord being
  // pressed is very likely one the app itself is bound to, and the window
  // handler would act on it instead of it being recorded. Capture phase, the
  // same place that handler lives.
  useEffect(() => {
    if (recording === null) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { setRecording(null); return; }
      if (e.code === 'Backspace') { write(withBinding(overrides, recording, '')); setRecording(null); return; }
      // A modifier on its own is the user still reaching for the chord.
      const chord = chordOf(e);
      if (chord === null) return;
      setRecording(null);
      // Taken already: two actions on one chord means the second never runs,
      // so say whose it is and let the user choose, rather than writing a
      // binding that quietly does nothing.
      const other = ownerOf(map, chord, recording);
      if (other !== null) { setClash({ id: recording, chord, other }); return; }
      bind(recording, chord);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  // `write` and `overrides` are read at the moment a key arrives, and
  // rebinding the listener on every settings change would drop a press.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, overrides]);

  const clashRow = clash && (
    <div className="shortcut-clash">
      <span>
        <strong>{formatChord(clash.chord)}</strong> is already {labelOf(clash.other)}.
        {' '}Two actions on one chord means only {labelOf(ownerWins(clash.id, clash.other))} runs.
      </span>
      <div className="shortcut-clash-actions">
        <button
          className="btn-primary btn-sm"
          onClick={() => {
            // The other action loses the chord rather than keeping a binding
            // that no longer reaches it.
            write({ ...withBinding(overrides, clash.other, ''), [clash.id]: clash.chord });
            setClash(null);
          }}
        >
          Reassign
        </button>
        <button className="btn-secondary btn-sm" onClick={() => { bind(clash.id, clash.chord); setClash(null); }}>
          Bind anyway
        </button>
        <button className="btn-secondary btn-sm" onClick={() => setClash(null)}>Cancel</button>
      </div>
    </div>
  );

  return (
    <section className="panel-section">
      <div className="panel-section-header">
        <h3>Keyboard shortcuts</h3>
        <button
          className="btn-secondary btn-sm"
          onClick={() => write({})}
          disabled={Object.keys(overrides).length === 0}
        >
          Reset all
        </button>
      </div>
      <p className="form-hint">
        Click a shortcut and press the keys you want. Escape keeps what was there, Backspace
        leaves the action unbound so the keys reach the shell instead. Ctrl+W and Ctrl+F are not
        offered: those belong to readline and to whatever is running on the far end.
      </p>

      {clashRow}

      {GROUPS.map((group) => (
        <div key={group} className="shortcut-group">
          <div className="shortcut-group-title">{group}</div>
          {ACTIONS.filter((a) => a.group === group).map((action) => {
            const chords = map[action.id];
            const shared = chords
              .flatMap((c) => conflicts.get(c) ?? [])
              .find((id) => id !== action.id);
            return (
              <div key={action.id} className="shortcut-row">
                <div className="shortcut-label">
                  <span>{action.label}</span>
                  <span className="form-hint">{action.detail}</span>
                  {shared !== undefined && (
                    <span className="form-hint form-hint-warn">
                      {conflictNote(action.id, shared)}
                    </span>
                  )}
                </div>
                <button
                  className={`shortcut-chord${recording === action.id ? ' recording' : ''}`}
                  onClick={() => setRecording(recording === action.id ? null : action.id)}
                >
                  {recording === action.id ? 'Press keys…' : formatChords(chords)}
                </button>
                <button
                  className="btn-secondary btn-sm"
                  onClick={() => write(withBinding(overrides, action.id, null))}
                  disabled={overrides[action.id] === undefined}
                >
                  Reset
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}

/**
 * Which of two actions sharing a chord actually runs.
 *
 * The window handler is in the capture phase, so it always takes the key
 * before the terminal's handler sees it.
 */
function labelOf(id: ActionId): string {
  return ACTIONS.find((a) => a.id === id)?.label ?? id;
}

/** Of two actions on one chord, the one the key actually reaches. */
function ownerWins(self: ActionId, other: ActionId): ActionId {
  // The window handler is in the capture phase, so it takes the key before
  // the terminal's handler is offered it. Between two on the same surface,
  // the table's order decides.
  const selfTerminal = TERMINAL_ACTIONS.includes(self);
  const otherTerminal = TERMINAL_ACTIONS.includes(other);
  if (selfTerminal !== otherTerminal) return selfTerminal ? other : self;
  return ACTIONS.findIndex((a) => a.id === self) < ACTIONS.findIndex((a) => a.id === other) ? self : other;
}

function conflictNote(self: ActionId, other: ActionId): string {
  const name = ACTIONS.find((a) => a.id === other)?.label ?? other;
  const selfIsTerminal = TERMINAL_ACTIONS.includes(self);
  const otherIsTerminal = TERMINAL_ACTIONS.includes(other);
  if (selfIsTerminal && !otherIsTerminal) return `Also ${name}, which takes the keys first.`;
  if (!selfIsTerminal && otherIsTerminal) return `Also ${name}, which will not see the keys.`;
  return `Also ${name}.`;
}
