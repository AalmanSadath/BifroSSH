import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import * as ipc from '../ipc';
import { useAppStore } from '../store/appStore';
import { THEMES } from '../styles/themes';
import { clockTime, compressIdle, eventsBy, parseCast, parseSize, type Cast } from '../asciicast';

interface Props {
  path: string;
}

/** A pause longer than this plays as this long. */
const MAX_IDLE = 2;
const SPEEDS = [1, 2, 4] as const;

/**
 * Plays an asciicast recording in a terminal of its own, in place in the
 * Recordings panel.
 *
 * The terminal takes the recording's size, not the window's, and changes
 * with the resizes the recording has in it, since what was drawn assumed
 * that size. Seeking back resets the terminal and replays everything up to
 * the new point in one write: terminal output is a stream, and there is no
 * other way to know what the screen held at a given moment.
 */
export default function CastPlayer({ path }: Props) {
  const settings = useAppStore((s) => s.settings);
  const customThemes = useAppStore((s) => s.customThemes);
  const [cast, setCast] = useState<Cast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [position, setPosition] = useState(0);

  const boxRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  /** Where playback is, kept outside React so the frame loop does not re-render per event. */
  const clock = useRef({ at: 0, next: 0 });

  useEffect(() => {
    let live = true;
    setCast(null);
    setError(null);
    setPlaying(false);
    setPosition(0);
    ipc.readTextFile(path)
      .then((text) => {
        if (!live) return;
        const parsed = parseCast(text);
        const events = compressIdle(parsed.events, MAX_IDLE);
        setCast({ ...parsed, events, duration: events.length > 0 ? events[events.length - 1].t : 0 });
        setPlaying(true);
        // Keys go to the player from here on, not to whatever had focus.
        rootRef.current?.focus();
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [path]);

  useEffect(() => {
    if (!cast || !boxRef.current) return;
    const term = new Terminal({
      cols: cast.cols,
      rows: cast.rows,
      theme: THEMES[settings.theme] ?? customThemes[settings.theme] ?? THEMES['bifrossh-dark'],
      fontFamily: settings.font_family,
      fontSize: settings.font_size,
      lineHeight: 1.2,
      scrollback: 0,
      disableStdin: true,
      cursorBlink: false,
    });
    term.open(boxRef.current);
    termRef.current = term;
    clock.current = { at: 0, next: 0 };
    return () => {
      term.dispose();
      termRef.current = null;
    };
    // The settings are read once: a theme changed mid-playback can wait for the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cast]);

  /** Writes the events from where playback is up to time `t`, in one go. */
  const advance = useCallback((t: number) => {
    const term = termRef.current;
    if (!cast || !term) return;
    const until = eventsBy(cast.events, t);
    let out = '';
    for (let i = clock.current.next; i < until; i++) {
      const e = cast.events[i];
      if (e.kind === 'o') {
        out += e.data;
      } else {
        const size = parseSize(e.data);
        if (size) {
          if (out) term.write(out);
          out = '';
          term.resize(size.cols, size.rows);
        }
      }
    }
    if (out) term.write(out);
    clock.current = { at: t, next: until };
  }, [cast]);

  const seek = useCallback((t: number) => {
    const term = termRef.current;
    if (!cast || !term) return;
    const target = Math.min(Math.max(0, t), cast.duration);
    if (target < clock.current.at) {
      term.reset();
      term.resize(cast.cols, cast.rows);
      clock.current = { at: 0, next: 0 };
    }
    advance(target);
    setPosition(target);
  }, [cast, advance]);

  useEffect(() => {
    if (!playing || !cast) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const t = Math.min(clock.current.at + ((now - last) / 1000) * speed, cast.duration);
      last = now;
      advance(t);
      setPosition(t);
      if (t >= cast.duration) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, speed, cast, advance]);

  const toggle = useCallback(() => {
    if (!cast) return;
    // Play at the end starts over, as every player does.
    if (!playing && clock.current.at >= cast.duration) seek(0);
    setPlaying((p) => !p);
  }, [cast, playing, seek]);

  /**
   * Space and the arrows, while the player has focus. On the player rather
   * than the window, so typing anywhere else never drives it.
   */
  const onKey = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    if (e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      seek(clock.current.at + 5);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      seek(clock.current.at - 5);
    }
  };

  return (
    <div className="cast-player" ref={rootRef} tabIndex={-1} onKeyDown={onKey}>
      <div className="cast-title">
        <span className="cast-title-name">{cast?.title ?? path.split(/[\\/]/).pop()}</span>
        <span className="cast-title-path" title={path}>{path}</span>
      </div>
      {error ? (
        <p className="form-error">{error}</p>
      ) : !cast ? (
        <p className="form-hint">Reading the recording…</p>
      ) : (
        <>
          <div className="cast-screen">
            <div ref={boxRef} />
          </div>
          <div className="cast-controls">
            <button type="button" className="btn-secondary btn-sm cast-play" onClick={toggle} title="Space">
              {playing ? 'Pause' : 'Play'}
            </button>
            <span className="cast-time">{clockTime(position)}</span>
            <input
              type="range"
              className="cast-seek"
              min={0}
              max={cast.duration || 0}
              step="any"
              value={position}
              onChange={(e) => seek(Number(e.target.value))}
              aria-label="Position"
            />
            <span className="cast-time">{clockTime(cast.duration)}</span>
            <div className="cast-speeds">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`cast-speed${speed === s ? ' active' : ''}`}
                  onClick={() => setSpeed(s)}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>
          <p className="form-hint">
            Pauses longer than {MAX_IDLE} seconds are shortened. Space plays and pauses; the arrow keys skip 5 seconds.
          </p>
        </>
      )}
    </div>
  );
}
