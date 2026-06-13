import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';

function hexToRgb(hex: string) {
  const c = hex.startsWith('#') ? hex.slice(1) : hex;
  if (c.length !== 6) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(c.slice(0,2),16), g: parseInt(c.slice(2,4),16), b: parseInt(c.slice(4,6),16) };
}

function rgbToHex(r: number, g: number, b: number) {
  return '#' + [r,g,b].map(v => Math.round(Math.max(0,Math.min(255,v))).toString(16).padStart(2,'0')).join('');
}

function rgbToHsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max, v = max;
  if (d !== 0) {
    if (max === r) h = ((g-b)/d + (g<b?6:0)) / 6;
    else if (max === g) h = ((b-r)/d + 2) / 6;
    else h = ((r-g)/d + 4) / 6;
  }
  return { h: h*360, s: s*100, v: v*100 };
}

function hsvToRgb(h: number, s: number, v: number) {
  h /= 360; s /= 100; v /= 100;
  const i = Math.floor(h*6), f = h*6-i;
  const p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
  let r=0,g=0,b=0;
  switch(i%6) {
    case 0: r=v;g=t;b=p; break; case 1: r=q;g=v;b=p; break;
    case 2: r=p;g=v;b=t; break; case 3: r=p;g=q;b=v; break;
    case 4: r=t;g=p;b=v; break; default: r=v;g=p;b=q;
  }
  return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
}

interface PanelProps {
  value: string;
  onChange: (v: string) => void;
  onClose: () => void;
  pos: { top: number; left: number };
}

function PickerPanel({ value, onChange, onClose, pos }: PanelProps) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  const initRgb = valid ? hexToRgb(value) : { r: 0, g: 0, b: 0 };
  const initHsv = rgbToHsv(initRgb.r, initRgb.g, initRgb.b);

  const [hue, setHue] = useState(initHsv.h);
  const [sat, setSat] = useState(initHsv.s);
  const [bri, setBri] = useState(initHsv.v);
  const [hexVal, setHexVal] = useState(valid ? value : '#000000');

  const areaRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  function emit(h: number, s: number, v: number) {
    const { r, g, b } = hsvToRgb(h, s, v);
    const hex = rgbToHex(r, g, b);
    setHexVal(hex);
    onChange(hex);
  }

  function handleArea(e: React.PointerEvent) {
    if (!(e.buttons & 1)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = areaRef.current!.getBoundingClientRect();
    const s = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * 100;
    const v = Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height)) * 100;
    setSat(s); setBri(v); emit(hue, s, v);
  }

  function handleHue(e: React.PointerEvent) {
    if (!(e.buttons & 1)) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = hueRef.current!.getBoundingClientRect();
    const h = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) * 360;
    setHue(h); emit(h, sat, bri);
  }

  const { r, g, b } = hsvToRgb(hue, sat, bri);
  const channels = [
    { label: 'R', val: r, key: 'r' as const },
    { label: 'G', val: g, key: 'g' as const },
    { label: 'B', val: b, key: 'b' as const },
  ];

  function setChannel(key: 'r'|'g'|'b', newVal: number) {
    const nr = key==='r' ? newVal : r;
    const ng = key==='g' ? newVal : g;
    const nb = key==='b' ? newVal : b;
    const hsv = rgbToHsv(nr, ng, nb);
    setHue(hsv.h); setSat(hsv.s); setBri(hsv.v);
    const hex = rgbToHex(nr, ng, nb);
    setHexVal(hex); onChange(hex);
  }

  const adjustedPos = {
    top: Math.min(pos.top, window.innerHeight - 260),
    left: Math.min(pos.left, window.innerWidth - 340),
  };

  return createPortal(
    <div ref={panelRef} className="cp-panel" style={{ position: 'fixed', top: adjustedPos.top, left: adjustedPos.left, zIndex: 9999 }}>
      <div className="cp-main">
        <div
          ref={areaRef}
          className="cp-area"
          style={{ '--cp-hue': `hsl(${hue},100%,50%)` } as React.CSSProperties}
          onPointerDown={handleArea}
          onPointerMove={handleArea}
        >
          <div className="cp-area-cursor" style={{ left: `${sat}%`, top: `${100-bri}%` }} />
        </div>
        <div ref={hueRef} className="cp-hue-bar" onPointerDown={handleHue} onPointerMove={handleHue}>
          <div className="cp-hue-thumb" style={{ top: `${hue/360*100}%` }} />
        </div>
        <div className="cp-channels">
          {channels.map(({ label, val, key }) => (
            <div key={key} className="cp-ch-row">
              <span className="cp-ch-label">{label}:</span>
              <input
                className="cp-ch-input"
                type="number"
                min={0} max={255}
                value={val}
                onChange={(e) => { const n = parseInt(e.target.value,10); if (!isNaN(n)) setChannel(key, Math.max(0,Math.min(255,n))); }}
              />
              <button className="cp-ch-btn" onMouseDown={(e) => { e.preventDefault(); setChannel(key, Math.min(255, val+1)); }}>+</button>
              <button className="cp-ch-btn" onMouseDown={(e) => { e.preventDefault(); setChannel(key, Math.max(0, val-1)); }}>−</button>
            </div>
          ))}
        </div>
      </div>
      <div className="cp-footer">
        <div className="cp-preview" style={{ background: hexVal }} />
        <input
          className="cp-hex-input"
          type="text"
          value={hexVal}
          maxLength={7}
          spellCheck={false}
          onChange={(e) => {
            setHexVal(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) {
              onChange(e.target.value);
              const rgb = hexToRgb(e.target.value);
              const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
              setHue(hsv.h); setSat(hsv.s); setBri(hsv.v);
            }
          }}
        />
      </div>
    </div>,
    document.body,
  );
}

export function ColorPickerField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const swatchRef = useRef<HTMLDivElement>(null);
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);

  function openPicker() {
    const r = swatchRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.top, left: r.right + 10 });
    setOpen(true);
  }

  return (
    <div className="te-color-field">
      <div
        ref={swatchRef}
        className="te-color-swatch"
        style={{ background: valid ? value : '#000', cursor: 'pointer' }}
        onClick={openPicker}
      />
      <input
        type="text"
        className="te-color-hex"
        value={value}
        onChange={(e) => { if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) onChange(e.target.value); }}
        maxLength={7}
        spellCheck={false}
      />
      {open && <PickerPanel value={value} onChange={onChange} onClose={() => setOpen(false)} pos={pos} />}
    </div>
  );
}
