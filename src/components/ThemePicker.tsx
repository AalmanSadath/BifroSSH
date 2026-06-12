import { THEMES } from '../styles/themes';

interface Props {
  value: string;
  onChange: (id: string) => void;
}

export function ThumbNail({ id }: { id: string }) {
  const t = THEMES[id];
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
  return (
    <div className="theme-picker">
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
