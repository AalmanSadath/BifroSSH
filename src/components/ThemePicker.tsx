import { useAppStore } from '../store/appStore';
import { THEMES } from '../styles/themes';
import type { NamedTheme } from '../styles/themes';

interface Props {
  value: string;
  onChange: (id: string) => void;
}

export function ThumbNail({ id }: { id: string }) {
  const customThemes = useAppStore((s) => s.customThemes);
  const t: NamedTheme | undefined = THEMES[id] ?? customThemes[id];
  if (!t) return null;

  const bars = [
    { color: t.green,   width: '72%' },
    { color: t.foreground, width: '55%' },
    { color: t.red,     width: '40%' },
    { color: t.yellow,  width: '60%' },
    { color: t.cyan,    width: '30%' },
    { color: t.blue,    width: '48%' },
  ];

  return (
    <div className="theme-thumb" style={{ background: t.background }}>
      <div className="theme-thumb-bars">
        {bars.map((b, i) => (
          <div
            key={i}
            className="theme-thumb-bar"
            style={{ background: b.color, width: b.width }}
          />
        ))}
      </div>
      <div className="theme-thumb-cursor" style={{ background: t.cursor ?? t.foreground }} />
    </div>
  );
}

export default function ThemePicker({ value, onChange }: Props) {
  const customThemes = useAppStore((s) => s.customThemes);
  const hasCustom = Object.keys(customThemes).length > 0;

  return (
    <div className="theme-picker">
      {hasCustom && (
        <>
          <div className="theme-picker-divider">Custom</div>
          {Object.entries(customThemes).map(([id, t]) => (
            <button
              key={id}
              type="button"
              className={`theme-card${value === id ? ' active' : ''}`}
              onClick={() => onChange(id)}
              title={t.name}
            >
              <ThumbNail id={id} />
              <span className="theme-card-name">{t.name}</span>
            </button>
          ))}
          <div className="theme-picker-divider">Default</div>
        </>
      )}
      {Object.entries(THEMES).map(([id, t]) => (
        <button
          key={id}
          type="button"
          className={`theme-card${value === id ? ' active' : ''}`}
          onClick={() => onChange(id)}
          title={t.name}
        >
          <ThumbNail id={id} />
          <span className="theme-card-name">{t.name}</span>
        </button>
      ))}
    </div>
  );
}
