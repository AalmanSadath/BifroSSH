import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import * as ipc from '../ipc';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store/appStore';
import { THEMES } from '../styles/themes';
import '@xterm/xterm/css/xterm.css';

interface Props {
  sessionId: string;
  serverId: string;
  active: boolean;
}

interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export default function TerminalView({ sessionId, serverId, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const { settings, servers, removeSession, sessionThemeOverrides, customThemes } = useAppStore();

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [results, setResults] = useState({ index: -1, count: 0 });
  const [badRegex, setBadRegex] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  function effectiveThemeKey() {
    if (sessionThemeOverrides[sessionId]) return sessionThemeOverrides[sessionId];
    const server = servers.find((s) => s.id === serverId);
    return server?.theme ?? settings.theme;
  }

  // The resolved key, so the effect below can depend on a string. Depending on
  // `servers` instead re-runs it whenever anything in that array changes, and
  // OS detection rewrites it a second or two after every first connect, which
  // reassigns the theme and forces xterm to repaint a terminal that has only
  // just appeared.
  const themeKey = effectiveThemeKey();

  /**
   * The theme to render with, built in or one the user made.
   *
   * Custom themes live in their own map rather than being merged into THEMES,
   * so looking only at THEMES silently fell back to the default: the host form
   * showed the chosen name while the session ignored it.
   */
  function resolveTheme() {
    return THEMES[themeKey] ?? customThemes[themeKey] ?? THEMES['bifrossh-dark'];
  }

  /**
   * Highlight colours drawn from the session's own theme.
   *
   * The decoration colours must be `#RRGGBB`: xterm mis-parses an alpha suffix
   * badly enough to black out the canvas. So the softening that alpha would
   * have given is done here, by mixing toward the theme's own background,
   * which keeps the highlight legible on light and dark themes alike.
   */
  const decorations = useCallback(() => {
    const theme = resolveTheme();
    // Every colour in ITheme is optional, so a theme that omits these still
    // has to produce something visible.
    const dim = theme.yellow ?? '#d29922';
    const bright = theme.brightYellow ?? dim;
    const bg = theme.background ?? '#0d1117';

    const mix = (color: string, weight: number) => {
      const parse = (hex: string) => {
        const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
        return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
      };
      const [fg, base] = [parse(color), parse(bg)];
      if (!fg || !base) return color;
      const channel = (i: number) =>
        Math.round(fg[i] * weight + base[i] * (1 - weight))
          .toString(16)
          .padStart(2, '0');
      return `#${channel(0)}${channel(1)}${channel(2)}`;
    };

    return {
      matchBackground: mix(dim, 0.35),
      matchBorder: mix(dim, 0.6),
      matchOverviewRuler: dim,
      activeMatchBackground: mix(bright, 0.7),
      activeMatchBorder: bright,
      activeMatchColorOverviewRuler: bright,
    };
  }, [themeKey, customThemes[themeKey]]);

  /**
   * `incremental` is for typing, where the match under the cursor should be
   * extended rather than jumped past on every keystroke.
   */
  const runSearch = useCallback(
    (forward: boolean, incremental = false) => {
      const addon = searchRef.current;
      if (!addon) return;
      if (!query) {
        addon.clearDecorations();
        setResults({ index: -1, count: 0 });
        setBadRegex(false);
        return;
      }
      // A half-typed pattern like `(fo` is the normal state of typing one, so
      // it is reported in the bar rather than thrown.
      if (options.regex) {
        try {
          new RegExp(query);
        } catch {
          addon.clearDecorations();
          setResults({ index: -1, count: 0 });
          setBadRegex(true);
          return;
        }
      }
      setBadRegex(false);
      setSearchError(null);
      const opts = { ...options, incremental, decorations: decorations() };
      // A throw here would otherwise escape the effect that calls this and
      // take the whole React tree down with it, leaving a blank window over a
      // failed search.
      try {
        if (forward) addon.findNext(query, opts);
        else addon.findPrevious(query, opts);
      } catch (e) {
        console.error('Terminal search failed', e);
        setSearchError(String(e));
        setResults({ index: -1, count: 0 });
      }
    },
    [query, options, decorations],
  );

  const closeSearch = useCallback(() => {
    searchRef.current?.clearDecorations();
    setSearchOpen(false);
    setResults({ index: -1, count: 0 });
    setBadRegex(false);
    setSearchError(null);
    termRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const theme = resolveTheme();
    const term = new Terminal({
      theme,
      fontSize: settings.font_size,
      fontFamily: settings.font_family,
      lineHeight: 1.2,
      cursorStyle: settings.cursor_style as 'block' | 'underline' | 'bar',
      cursorBlink: settings.cursor_blink,
      scrollback: 10000,
      allowTransparency: false,
      // The search addon highlights matches through registerDecoration, which
      // xterm still classes as proposed and refuses to hand out otherwise.
      // Proposed API can change between xterm minor versions, so an upgrade
      // wants the search highlighting checked rather than assumed.
      allowProposedApi: true,
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;
    searchRef.current = searchAddon;

    searchAddon.onDidChangeResults((r) => {
      setResults({ index: r?.resultIndex ?? -1, count: r?.resultCount ?? 0 });
    });

    // Defer fit until after paint so font metrics and layout are settled.
    // Two rAF frames: first ensures React has flushed DOM, second ensures
    // the browser has performed a layout pass with correct character metrics.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitAddon.fit();
        // Explicitly push the real PTY size to the server — onResize alone
        // can miss this if the cols/rows match the xterm default (80×24).
        const { cols, rows } = term;
        if (cols > 0 && rows > 0) {
          ipc.sshResize(sessionId, cols, rows).catch(() => {});
        }
      });
    });

    // Matched on ev.code rather than ev.key: code is the physical key, so
    // these keep working on a layout where that key does not produce an F.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey) {
        // Ctrl+Shift+F, not Ctrl+F: a bare Ctrl+F is a control character the
        // remote shell, less and vim all want, and taking it would break them.
        if (ev.code === 'KeyF') {
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.select());
          return false;
        }
        if (ev.code === 'KeyC') {
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        if (ev.code === 'KeyV') {
          // term.paste rather than sending the bytes ourselves: it wraps the
          // text in the bracketed paste markers when the remote application
          // has asked for them, which is what stops a multi-line paste being
          // run a line at a time by the shell, or auto-indented by vim.
          navigator.clipboard.readText()
            .then((text) => { if (text) term.paste(text); })
            .catch(() => {});
          return false;
        }
      }
      return true;
    });

    term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      ipc.sshSendInput(sessionId, bytes).catch(() => {});
    });

    term.onResize(({ cols, rows }) => {
      ipc.sshResize(sessionId, cols, rows).catch(() => {});
    });

    term.onSelectionChange(() => {
      const pos = term.getSelectionPosition();
      if (!pos) return;
      const buf = term.buffer.active;
      // pos.end.y is 1-based buffer-absolute; cursor is baseY + cursorY (0-based) + 1
      const cursorAbsRow = buf.baseY + buf.cursorY + 1;
      if (pos.end.y > cursorAbsRow) term.clearSelection();
    });

    // Unsubscribing is asynchronous while disposal is not, so an event can
    // still arrive after the terminal is gone. Writing to a disposed terminal
    // throws, inside an event callback where nothing would catch it.
    let disposed = false;
    const decode = (payload: string) =>
      Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));

    // Live chunks wait here until the backlog below has been written. The
    // backend stops holding output the moment ssh_attach returns, so without
    // this a live chunk delivered before that promise settles would be
    // written ahead of output that came before it.
    let replayed = false;
    const queued: Uint8Array[] = [];

    const unlistenOutput = listen<string>(`ssh-output:${sessionId}`, (ev) => {
      if (disposed) return;
      const buf = decode(ev.payload);
      if (buf.length === 0) return;
      if (replayed) term.write(buf);
      else queued.push(buf);
    });

    const unlistenClose = listen(`ssh-closed:${sessionId}`, () => {
      // Nothing is written here: removing the session unmounts this terminal
      // in the same tick, so any message would be gone before it was read.
      removeSession(sessionId);
    });

    // Collect what the shell said before the listener above existed. The
    // session id only reaches us once the connect call has returned, by which
    // point the motd and first prompt have usually already been produced, and
    // Tauri drops events nobody is listening for. Ordered after the listen so
    // nothing can arrive between the two and be written out of sequence.
    unlistenOutput
      .then(() => ipc.sshAttach(sessionId))
      .then((pending) => {
        if (disposed) return;
        if (pending) {
          const buf = decode(pending);
          if (buf.length > 0) term.write(buf);
        }
      })
      .catch(() => {})
      .finally(() => {
        // Even if the replay failed, the queue has to drain or the session
        // shows nothing at all from here on.
        if (disposed) return;
        replayed = true;
        for (const buf of queued) term.write(buf);
        queued.length = 0;
      });

    return () => {
      disposed = true;
      unlistenOutput.then((fn) => fn());
      unlistenClose.then((fn) => fn());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Apply theme/font changes without recreating the terminal
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = resolveTheme();
    term.options.fontSize = settings.font_size;
    term.options.fontFamily = settings.font_family;
    term.options.cursorStyle = settings.cursor_style as 'block' | 'underline' | 'bar';
    term.options.cursorBlink = settings.cursor_blink;
    fitRef.current?.fit();
    // customThemes[themeKey] rather than the whole map: it changes identity
    // when that one theme is edited, so a save in the theme editor repaints
    // the sessions using it and nothing else.
  }, [
    themeKey,
    customThemes[themeKey],
    settings.font_size,
    settings.font_family,
    settings.cursor_style,
    settings.cursor_blink,
  ]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          fitRef.current?.fit();
          termRef.current?.focus();
        });
      });
    }
  }, [active]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => fitRef.current?.fit());
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  // Re-runs as the query or the toggles change, so the count and highlights
  // track what is in the box rather than waiting for Enter.
  useEffect(() => {
    if (searchOpen) runSearch(true, true);
  }, [searchOpen, runSearch]);

  const toggles: { id: keyof SearchOptions; label: string; title: string }[] = [
    { id: 'caseSensitive', label: 'Aa', title: 'Match case' },
    { id: 'wholeWord', label: 'ab', title: 'Whole word' },
    { id: 'regex', label: '.*', title: 'Regular expression' },
  ];

  return (
    <div className="terminal-pane" style={{ display: active ? 'flex' : 'none' }}>
      {searchOpen && (
        // Escape is handled here rather than on the input: clicking a toggle
        // moves focus to that button, and a handler on the input alone would
        // stop working the moment anything else in the bar was touched.
        <div
          className="term-search"
          onKeyDown={(e) => {
            if (e.key === 'Escape') closeSearch();
          }}
        >
          <input
            ref={searchInputRef}
            className={badRegex ? 'term-search-bad' : undefined}
            value={query}
            placeholder="Find in scrollback"
            spellCheck={false}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(!e.shiftKey);
              }
            }}
          />

          <span
            className={`term-search-count${searchError ? ' term-search-failed' : ''}`}
            title={searchError ?? undefined}
          >
            {searchError
              ? 'search failed'
              : badRegex
                ? 'bad pattern'
                : results.count === 0
                  ? query
                    ? 'no results'
                    : ''
                  : `${results.index + 1}/${results.count}`}
          </span>

          {toggles.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`term-search-toggle${options[t.id] ? ' active' : ''}`}
              title={t.title}
              aria-pressed={options[t.id]}
              // Focus goes back to the box after every button in this bar. The
              // query is what you are working on, so leaving focus on a toggle
              // strands Enter and leaves the button looking selected.
              onClick={() => {
                setOptions((o) => ({ ...o, [t.id]: !o[t.id] }));
                searchInputRef.current?.focus();
              }}
            >
              {t.label}
            </button>
          ))}

          <button
            type="button"
            className="term-search-btn"
            title="Previous match (Shift+Enter)"
            onClick={() => {
              runSearch(false);
              searchInputRef.current?.focus();
            }}
          >
            ↑
          </button>
          <button
            type="button"
            className="term-search-btn"
            title="Next match (Enter)"
            onClick={() => {
              runSearch(true);
              searchInputRef.current?.focus();
            }}
          >
            ↓
          </button>
          <button
            type="button"
            className="term-search-btn"
            title="Close (Escape)"
            onClick={closeSearch}
          >
            ✕
          </button>

          {searchError && <p className="term-search-detail">{searchError}</p>}
        </div>
      )}

      {/* Declarative rather than set from the theme effect, so the padding
          around the canvas can never be left showing the previous theme. */}
      <div
        ref={containerRef}
        className="terminal-container"
        style={{
          '--term-bg': resolveTheme().background,
        } as React.CSSProperties}
      />
    </div>
  );
}
