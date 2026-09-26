import { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { DEFAULT_HIGHLIGHT_RULES, HIGHLIGHT_COLORS, patternError } from '../../highlight';
import { THEMES } from '../../styles/themes';
import type { HighlightRule } from '../../types';
import { Picker, usePatch, type PickerOption } from './Picker';

/** "brightYellow" reads as "Bright yellow" in the menu. */
const COLOR_OPTIONS: PickerOption<string>[] = HIGHLIGHT_COLORS.map((c) => ({
  value: c,
  label: c.replace(/^bright([A-Z])/, (_, l: string) => `Bright ${l.toLowerCase()}`).replace(/^[a-z]/, (l) => l.toUpperCase()),
}));

/** The keyword highlighting switch and its list of rules. */
export default function HighlightRules() {
  const { settings, customThemes } = useAppStore();
  const patch = usePatch();
  const rules = settings.highlight_rules;
  // Swatches in the default terminal theme's own colours, since that is what
  // most tabs will draw them in.
  const theme = THEMES[settings.theme] ?? customThemes[settings.theme] ?? THEMES['bifrossh-dark'];

  const write = (next: HighlightRule[]) => patch({ highlight_rules: next });
  const change = (i: number, p: Partial<HighlightRule>) =>
    write(rules.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <section className="panel-section">
      <h3>Highlighting</h3>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.highlight_enabled}
          onChange={(e) => patch({ highlight_enabled: e.target.checked })}
        />
        <span>Colour keywords in terminal output</span>
      </label>
      <p className="form-hint">
        Each rule is a regular expression. Where two overlap, the one that starts first wins, then
        the one higher in this list. Full-screen programs such as vim and less draw their own
        colours and are left alone.
      </p>

      <div className={`highlight-rules${settings.highlight_enabled ? '' : ' highlight-rules-off'}`}>
        {rules.map((rule, i) => (
          <RuleRow
            // The pattern is in the key so a row is rebuilt, with its draft,
            // when the saved pattern under it changes.
            key={`${i}:${rule.pattern}`}
            rule={rule}
            swatch={theme[rule.color as keyof typeof theme] as string | undefined}
            onPattern={(pattern) => change(i, { pattern })}
            onColor={(color) => change(i, { color })}
            onCase={(case_sensitive) => change(i, { case_sensitive })}
            onRemove={() => write(rules.filter((_, j) => j !== i))}
          />
        ))}
        {rules.length === 0 && <p className="form-hint">No rules.</p>}
      </div>

      <div className="settings-inline-row">
        <button
          className="btn-secondary btn-sm"
          onClick={() => write([...rules, { pattern: '', color: 'cyan', case_sensitive: false }])}
        >
          Add rule
        </button>
        <button className="btn-secondary btn-sm" onClick={() => write(DEFAULT_HIGHLIGHT_RULES)}>
          Restore defaults
        </button>
      </div>
    </section>
  );
}

function RuleRow({
  rule,
  swatch,
  onPattern,
  onColor,
  onCase,
  onRemove,
}: {
  rule: HighlightRule;
  swatch: string | undefined;
  onPattern: (pattern: string) => void;
  onColor: (color: string) => void;
  onCase: (caseSensitive: boolean) => void;
  onRemove: () => void;
}) {
  // Saved on Enter or on leaving the field rather than per keystroke: every
  // save rewrites the encrypted data file, and half a pattern is not one.
  const [draft, setDraft] = useState(rule.pattern);
  const error = patternError(draft);
  const commit = () => {
    if (draft !== rule.pattern) onPattern(draft);
  };

  return (
    <div className="highlight-rule">
      <span className="highlight-swatch" style={{ background: swatch }} />
      <div className="highlight-pattern">
        <input
          className={error ? 'input-error' : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
          placeholder={'\\bpattern\\b'}
          spellCheck={false}
          autoComplete="off"
        />
        {error && (
          <span className="form-hint form-hint-error">
            {error === 'Empty' ? 'Empty: matches nothing' : `Ignored: ${error}`}
          </span>
        )}
      </div>
      <div className="highlight-color">
        <Picker value={rule.color} options={COLOR_OPTIONS} onChange={onColor} />
      </div>
      <label className="checkbox-row highlight-case" title="Match upper and lower case exactly">
        <input type="checkbox" checked={rule.case_sensitive} onChange={(e) => onCase(e.target.checked)} />
        <span>Aa</span>
      </label>
      <button className="sftp-action-btn" onClick={onRemove} title="Remove this rule">
        ✕
      </button>
    </div>
  );
}
