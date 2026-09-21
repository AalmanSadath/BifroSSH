import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { openUrl } from '@tauri-apps/plugin-opener';
import * as ipc from '../ipc';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store/appStore';
import type { SessionTab, SshClosed } from '../types';
import { THEMES } from '../styles/themes';
import '@xterm/xterm/css/xterm.css';

interface Props {
  /** The tab this terminal belongs to; its session may come and go. */
  tab: SessionTab;
  /** On screen: the active tab, or beside it in a split. */
  visible: boolean;
  /** The one the keyboard goes to. Never true without `visible`. */
  focused: boolean;
  /** Split only: the pane header, with the tab's name and a way out. */
  header?: React.ReactNode;
}

interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export default function TerminalView({ tab, visible, focused, header }: Props) {
  const { tab_id: tabId, session_id: sessionId, server_id: serverId } = tab;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  /**
   * The session the terminal's own handlers send to. A ref, because the
   * handlers are bound once when the terminal is made and the session under
   * the tab changes on a reconnect. Null means keystrokes go nowhere.
   */
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  /** Whether a session has been bound before, so the next one is a reconnect. */
  const boundOnceRef = useRef(false);
  const { settings, servers, removeSession, markDropped, reconnectSession, sendInput, setActiveTab, sessionThemeOverrides, customThemes } = useAppStore();

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
    if (sessionThemeOverrides[tabId]) return sessionThemeOverrides[tabId];
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
  /// Pulled out of the lookups below so the dependency arrays can name it.
  /// `customThemes[themeKey]` is the one entry that matters, and it changes
  /// identity when that theme is edited, so a save in the theme editor
  /// repaints the sessions using it and nothing else.
  const activeCustomTheme = customThemes[themeKey];

  const resolveTheme = useCallback(
    () => THEMES[themeKey] ?? activeCustomTheme ?? THEMES['bifrossh-dark'],
    [themeKey, activeCustomTheme],
  );

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
  }, [resolveTheme]);

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
    const container = containerRef.current;

    const theme = resolveTheme();
    const term = new Terminal({
      theme,
      fontSize: settings.font_size,
      fontFamily: settings.font_family,
      lineHeight: 1.2,
      cursorStyle: settings.cursor_style,
      cursorBlink: settings.cursor_blink,
      scrollback: settings.scrollback_lines,
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
    // With no handler the addon falls back to window.open, which the webview
    // refuses, so clicking a link in a session did nothing at all. The opener
    // plugin was registered on the Rust side and its JavaScript half had never
    // been imported.
    //
    // The URL comes out of the remote server's output, so it is not trusted.
    // Two things keep that narrow: the addon's own link matcher only produces
    // http and https URLs, and `opener:default` permits only those two plus
    // mailto and tel. A server cannot get file:// or some registered scheme
    // handler opened by printing it.
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      openUrl(uri).catch((e) => console.error('Could not open link', uri, e));
    }));
    term.open(container);
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
        const sid = sessionIdRef.current;
        if (sid && cols > 0 && rows > 0) {
          ipc.sshResize(sid, cols, rows).catch(() => {});
        }
      });
    });

    // Matched on ev.code rather than ev.key: code is the physical key, so
    // these keep working on a layout where that key does not produce an F.
    // term.paste rather than sending the bytes ourselves: it wraps the text
    // in the bracketed paste markers when the remote application has asked for
    // them, which is what stops a multi-line paste being run a line at a time
    // by the shell, or auto-indented by vim.
    //
    // The browser first, the backend only if it refuses. readText wants a
    // user activation, which a keypress is and a right click is not, so the
    // keyboard route never reaches the fallback and the right-click route
    // always does. Asking the browser first keeps the common path in the
    // webview and the backend read for the case that has no alternative.
    const pasteFromClipboard = () => {
      navigator.clipboard.readText()
        .catch(() => ipc.clipboardReadText())
        .then((text) => { if (text) term.paste(text); })
        .catch((e) => console.error('Could not read the clipboard', e));
    };

    // Right-click pastes, the way a terminal is expected to. main.tsx already
    // suppresses the context menu everywhere, so nothing is being taken away.
    // Capture phase: xterm registers its own contextmenu handler on the
    // element inside this container.
    const onContextMenu = (ev: MouseEvent) => {
      ev.preventDefault();
      pasteFromClipboard();
    };
    container.addEventListener('contextmenu', onContextMenu, true);

    // Highlighting copies, the way a terminal emulator does. On mouseup
    // rather than on xterm's onSelectionChange, which fires on every mouse
    // move during a drag and would write the clipboard dozens of times per
    // selection; mouseup is the one moment a drag, a double-click word and a
    // triple-click line all pass through. The onSelectionChange handler
    // below, which clears a selection that runs past the cursor, has already
    // run by then, so a cleared selection is never copied. Ctrl+Shift+C
    // stays for anyone who reaches for it.
    // Left button only: the right button is the paste, and copying on its
    // release would overwrite the clipboard with the selection just after
    // reading it.
    const onMouseUp = (ev: MouseEvent) => {
      if (ev.button !== 0 || !term.hasSelection()) return;
      navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    };
    container.addEventListener('mouseup', onMouseUp);

    // Returning false tells xterm not to act on the key. It does not stop the
    // browser, which has its own Ctrl+Shift+C and Ctrl+Shift+V, and xterm
    // listens for the native copy and paste events those raise. Without
    // preventDefault both halves run: a paste arrived twice whenever the
    // clipboard was readable, which is exactly when the page had written it
    // itself, so text copied out of a terminal pasted double and text copied
    // from another application did not.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey) {
        // Ctrl+Shift+F, not Ctrl+F: a bare Ctrl+F is a control character the
        // remote shell, less and vim all want, and taking it would break them.
        if (ev.code === 'KeyF') {
          ev.preventDefault();
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.select());
          return false;
        }
        if (ev.code === 'KeyC') {
          ev.preventDefault();
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        if (ev.code === 'KeyV') {
          ev.preventDefault();
          pasteFromClipboard();
          return false;
        }
      }
      return true;
    });

    term.onData((data) => {
      const sid = sessionIdRef.current;
      if (!sid) {
        // Dropped. Enter is what the hands do to a dead session anyway, so
        // it is the reconnect; everything else goes nowhere.
        if (data === '\r') reconnectSession(tabId);
        return;
      }
      sendInput(tabId, Array.from(new TextEncoder().encode(data)));
    });

    term.onResize(({ cols, rows }) => {
      const sid = sessionIdRef.current;
      if (sid) ipc.sshResize(sid, cols, rows).catch(() => {});
    });

    term.onSelectionChange(() => {
      const pos = term.getSelectionPosition();
      if (!pos) return;
      const buf = term.buffer.active;
      // pos.end.y is 1-based buffer-absolute; cursor is baseY + cursorY (0-based) + 1
      const cursorAbsRow = buf.baseY + buf.cursorY + 1;
      if (pos.end.y > cursorAbsRow) term.clearSelection();
    });

    return () => {
      container.removeEventListener('contextmenu', onContextMenu, true);
      container.removeEventListener('mouseup', onMouseUp);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      searchRef.current = null;
    };
  // Once per tab. The session under it is bound by the effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Binds the terminal to whichever session the tab has. Runs again when the
   * session changes, which is a reconnect: the terminal and its scrollback
   * stay, and the new session's output continues below the old.
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term || !sessionId) return;

    // Unsubscribing is asynchronous while disposal is not, so an event can
    // still arrive after the terminal is gone. Writing to a disposed terminal
    // throws, inside an event callback where nothing would catch it.
    let disposed = false;
    const decode = (payload: string) =>
      Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));

    if (boundOnceRef.current) {
      term.write('\r\n\x1b[32m[Reconnected]\x1b[0m\r\n');
      // The PTY on the new session is 80x24 until told otherwise.
      if (term.cols > 0 && term.rows > 0) ipc.sshResize(sessionId, term.cols, term.rows).catch(() => {});
    }
    boundOnceRef.current = true;

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

    const unlistenClose = listen<SshClosed>(`ssh-closed:${sessionId}`, (ev) => {
      if (disposed) return;
      if (ev.payload.reason === 'dropped') {
        // The tab stays, with everything on it. The line marks where the
        // connection went in the scrollback, and the banner offers the way
        // back.
        term.write('\r\n\x1b[31m[Connection lost]\x1b[0m\r\n');
        markDropped(tabId);
        return;
      }
      // An exit the shell announced, or a close the user asked for. Nothing
      // is written: removing the tab unmounts this terminal in the same tick.
      removeSession(tabId);
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
    term.options.cursorStyle = settings.cursor_style;
    term.options.cursorBlink = settings.cursor_blink;
    term.options.scrollback = settings.scrollback_lines;
    fitRef.current?.fit();
  }, [
    resolveTheme,
    settings.font_size,
    settings.font_family,
    settings.cursor_style,
    settings.cursor_blink,
    settings.scrollback_lines,
  ]);

  // Two frames after becoming visible, so the box has a size to fit to.
  useEffect(() => {
    if (visible) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => fitRef.current?.fit());
      });
    }
  }, [visible]);

  useEffect(() => {
    if (focused) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => termRef.current?.focus());
      });
    }
  }, [focused]);

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
    <div
      className={`terminal-pane${tab.broadcast ? ' terminal-pane-broadcast' : ''}${header && focused ? ' terminal-pane-focused' : ''}`}
      style={{ display: visible ? 'flex' : 'none', '--term-bg': resolveTheme().background } as React.CSSProperties}
      onMouseDown={() => { if (!focused) setActiveTab(tabId); }}
    >
      {header}
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

      {tab.status === 'dropped' && (
        // Over the terminal rather than in place of it: the scrollback is the
        // point of keeping the tab, and it stays readable behind this.
        <div className="term-dropped">
          <div className="term-dropped-row">
            <span className="term-dropped-text">
              Connection lost.
              {tab.quick_info && ' A quick connection cannot be reopened without the credentials typed for it.'}
            </span>
            {!tab.quick_info && (
              <button
                className="btn-primary btn-sm"
                disabled={tab.reconnecting}
                onClick={() => reconnectSession(tabId)}
              >
                {tab.reconnecting ? 'Reconnecting…' : 'Reconnect'}
              </button>
            )}
            <button className="btn-secondary btn-sm" onClick={() => removeSession(tabId)}>Close</button>
          </div>
          {tab.error && <div className="term-dropped-error">{tab.error}</div>}
        </div>
      )}

      {/* The variable is set on the pane, declaratively rather than from the
          theme effect, so neither the padding around the canvas nor any
          slack under it can be left showing another colour. */}
      <div ref={containerRef} className="terminal-container" />
    </div>
  );
}
