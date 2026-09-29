import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ImageAddon } from '@xterm/addon-image';
import { IMAGE_OPTIONS } from '../terminalImages';
import { openUrl } from '@tauri-apps/plugin-opener';
import { findPaths } from '../paths';
import { TERMINAL_ACTIONS, actionFor, resolve as resolveShortcuts } from '../shortcuts';
import * as ipc from '../ipc';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store/appStore';
import { parseMark } from '../activity';
import { useHint } from './shared/useHint';
import { registerTerminal, unregisterTerminal } from '../terminalRegistry';
import { attachHighlighter, type HighlightState, type Highlighter } from '../terminalHighlighter';
import { HIGHLIGHT_COLORS, compileRules } from '../highlight';
import { attachCommandTracker, type CommandTracker } from '../terminalCommands';
import { attachSuggester, type Suggester } from '../terminalSuggest';
import { monitorWanted } from '../hostStats';
import MonitorBar from './MonitorBar';
import FilePickerModal from './FilePickerModal';
import { attachZmodem, toBase64, type TransferProgress, type ZmodemHandle } from '../zmodem';
import { formatSize } from '../transferStatus';
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
  /** Split only: the handle that drags this pane's left edge. */
  resizer?: React.ReactNode;
  /** Split only: this pane's share of the row, as a percentage. */
  width?: number;
}

/** Where the last ZMODEM download went, so the next one starts there; for every tab. */
let lastZmodemFolder: string | null = null;

/** A ZMODEM transfer waiting on the user: a folder to save into, or files to send. */
interface ZmodemPick {
  mode: 'folder' | 'files';
  startDir?: string;
  resolve: (chosen: string | string[] | null) => void;
}

/** A container tab's command ending sooner than this, and failing, is kept open to be read. */
const QUICK_FAILURE_MS = 3000;

interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export default function TerminalView({ tab, visible, focused, header, resizer, width }: Props) {
  const { tab_id: tabId, session_id: sessionId, server_id: serverId } = tab;
  const isLocal = tab.kind === 'local';
  /** Inside a container: paths and commands there are not the host's. */
  const inContainer = !!tab.container;
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const zmodemRef = useRef<ZmodemHandle | null>(null);
  const [transfer, setTransfer] = useState<TransferProgress | null>(null);
  const [zmodemPick, setZmodemPick] = useState<ZmodemPick | null>(null);
  /**
   * The session the terminal's own handlers send to. A ref, because the
   * handlers are bound once when the terminal is made and the session under
   * the tab changes on a reconnect. Null means keystrokes go nowhere.
   */
  const sessionIdRef = useRef<string | null>(sessionId);
  sessionIdRef.current = sessionId;
  /** Whether a session has been bound before, so the next one is a reconnect. */
  const boundOnceRef = useRef(false);
  const { settings, servers, removeSession, markDropped, reconnectSession, stopRetrying, retryingTabIds, sendInput, setActiveTab, sessionThemeOverrides, sessionZoom, zoomSession, customThemes, markActivity } = useAppStore();
  const hint = useHint();
  // A local shell has no host to read, and no connection to read it over.
  const monitorShown = tab.status !== 'error' && tab.kind !== 'local' && !inContainer
    && monitorWanted(settings.monitor_bar, servers.find((s) => s.id === serverId));

  // This tab's own size if it has been zoomed, else the one every terminal
  // uses. Same precedence as the theme override below it.
  const fontSize = sessionZoom[tabId] ?? settings.font_size;

  // The key handler below is attached once with the terminal; the bindings
  // can change under it, so it reads them through a ref.
  // The OSC handler is registered once, with the terminal, so it reaches the
  // store through a ref rather than the first render's action.
  const markActivityRef = useRef(markActivity);
  markActivityRef.current = markActivity;
  const highlighterRef = useRef<Highlighter | null>(null);
  const commandsRef = useRef<CommandTracker | null>(null);
  const suggesterRef = useRef<Suggester | null>(null);
  /** What the suggester reads each time it looks; a ref for the same reason as the highlighter's. */
  const suggestStateRef = useRef({ enabled: false, history: [] as string[] });
  /** What the highlighter reads each pass; kept in a ref so the terminal's
      once-per-tab effect can hand it a getter rather than a stale copy. */
  const highlightStateRef = useRef<HighlightState>({ enabled: false, rules: [], palette: {} });

  const shortcutsRef = useRef(resolveShortcuts(settings.shortcuts));
  shortcutsRef.current = resolveShortcuts(settings.shortcuts);
  const retrying = retryingTabIds.has(tabId);

  // The countdown in the dropped banner. Half a second's worth of
  // re-render, and only while a retry is actually pending.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!retrying || tab.retryAt === undefined) return;
    const id = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [retrying, tab.retryAt]);
  const countdown = tab.retryAt !== undefined
    ? Math.max(0, Math.ceil((tab.retryAt - Date.now()) / 1000))
    : null;

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
      fontSize,
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
    // Absolute paths in the output open in the SFTP panel, on this host.
    // Nothing leaves the app: the path is only ever listed over the SFTP
    // session, and a wrong guess is a "No such file" in the panel.
    term.registerLinkProvider({
      provideLinks(y, callback) {
        // The line the cursor is on is the one being typed. Echo makes
        // typed text output as far as the buffer knows, and a link under
        // the fingers is only in the way; once Enter is pressed the line
        // is history and links like the rest.
        const buf = term.buffer.active;
        if (y - 1 === buf.baseY + buf.cursorY) { callback(undefined); return; }
        // A path in a local shell is on this machine, not on a host the
        // SFTP panel could open.
        // Nor is a path in a container.
        if (isLocal || inContainer) { callback(undefined); return; }
        const line = buf.getLine(y - 1)?.translateToString(true) ?? '';
        callback(findPaths(line).map((p) => ({
          range: { start: { x: p.start + 1, y }, end: { x: p.end, y } },
          text: p.text,
          decorations: { underline: true, pointerCursor: true },
          activate: (_e, text) => useAppStore.getState().openInSftp(serverId, text),
        })));
      },
    });
    // OSC 133: the marks a shell emits around each command, if it has been
    // told to. True so the sequence is consumed rather than printed by
    // anything downstream; a shell that sends none simply never calls this.
    term.parser.registerOscHandler(133, (data) => {
      const mark = parseMark(data);
      if (mark) {
        markActivityRef.current(tabId, mark);
        commandsRef.current?.mark(mark.kind);
      }
      return true;
    });

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
        // Explicitly push the real PTY size to the server; onResize alone
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
        .then((text) => {
          if (!text) return;
          // Pasted text is typing as far as highlighting is concerned.
          highlighterRef.current?.markInput();
          term.paste(text);
        })
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
      if (ev.type !== 'keydown') return true;
      // Only the terminal's own three. By default they are Ctrl+Shift, not
      // Ctrl: a bare Ctrl+F is a control character the remote shell, less and
      // vim all want, and taking it would break them. An action the user
      // unbound matches nothing and so reaches the shell.
      switch (actionFor(ev, shortcutsRef.current, TERMINAL_ACTIONS)) {
        case 'term-search':
          ev.preventDefault();
          setSearchOpen(true);
          requestAnimationFrame(() => searchInputRef.current?.select());
          return false;
        case 'term-copy': {
          ev.preventDefault();
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        case 'term-paste':
          ev.preventDefault();
          pasteFromClipboard();
          return false;
        default:
          break;
      }
      // Right arrow at the end of the line takes the suggestion, the way fish
      // and zsh-autosuggestions do. With none showing, or with a modifier
      // held, it reaches the shell as usual.
      if (ev.key === 'ArrowRight' && !ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        const rest = suggesterRef.current?.current();
        if (rest) {
          ev.preventDefault();
          suggesterRef.current?.clear();
          highlighterRef.current?.markInput();
          // Through onData, exactly as if typed: to the session, and to every
          // tab this one broadcasts to.
          term.input(rest);
          return false;
        }
      }
      return true;
    });

    term.onData((data) => {
      // A transfer owns the session while it runs: anything typed would land
      // in the middle of the protocol. Ctrl+C is the way out.
      if (zmodemRef.current?.active()) {
        if (data.includes('\x03')) zmodemRef.current.cancel();
        return;
      }
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

    // What the tab menu reaches for when it is asked for a transcript.
    registerTerminal(tabId, term);

    zmodemRef.current = attachZmodem(term, {
      send: (bytes) => {
        const sid = sessionIdRef.current;
        return sid ? ipc.sshSendBytes(sid, toBase64(bytes)) : Promise.reject(new Error('the session has closed'));
      },
      done: () => {
        const sid = sessionIdRef.current;
        if (sid) ipc.sshTransferDone(sid).catch(() => {});
      },
      chooseFolder: async () => {
        const startDir = lastZmodemFolder ?? await ipc.defaultExportDir().catch(() => undefined);
        const chosen = await new Promise<string | string[] | null>((resolve) => setZmodemPick({ mode: 'folder', startDir, resolve }));
        if (typeof chosen === 'string') lastZmodemFolder = chosen;
        return typeof chosen === 'string' ? chosen : null;
      },
      chooseFiles: async () => {
        const chosen = await new Promise<string | string[] | null>((resolve) => setZmodemPick({ mode: 'files', resolve }));
        return Array.isArray(chosen) ? chosen : null;
      },
      progress: setTransfer,
      finished: (message, ok) => term.write(`\r\n\x1b[${ok ? 32 : 33}m[${message}]\x1b[0m\r\n`),
    });

    highlighterRef.current = attachHighlighter(term, () => highlightStateRef.current);
    // What is run at a prompt on a saved host is kept for its suggestions. A
    // quick connection has no host record to keep it against.
    commandsRef.current = attachCommandTracker(term, (command) => {
      if (serverId && !inContainer) useAppStore.getState().learnCommand(serverId, command);
    });
    suggesterRef.current = attachSuggester(term, commandsRef.current, () => suggestStateRef.current);

    return () => {
      zmodemRef.current?.cancel();
      zmodemRef.current = null;
      highlighterRef.current?.dispose();
      highlighterRef.current = null;
      suggesterRef.current?.dispose();
      suggesterRef.current = null;
      commandsRef.current?.dispose();
      commandsRef.current = null;
      unregisterTerminal(tabId);
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
    // Through the ZMODEM sentry, which hands the terminal everything that is
    // not a transfer.
    const output = (buf: Uint8Array) => {
      if (zmodemRef.current) zmodemRef.current.consume(buf);
      else term.write(buf);
    };

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
    const boundAt = Date.now();

    const unlistenOutput = listen<string>(`ssh-output:${sessionId}`, (ev) => {
      if (disposed) return;
      const buf = decode(ev.payload);
      if (buf.length === 0) return;
      if (replayed) output(buf);
      else queued.push(buf);
    });

    const unlistenClose = listen<SshClosed>(`ssh-closed:${sessionId}`, (ev) => {
      if (disposed) return;
      // A transfer cannot outlive its session; its half-written file goes.
      zmodemRef.current?.cancel();
      if (ev.payload.reason === 'dropped') {
        // The tab stays, with everything on it. The line marks where the
        // connection went in the scrollback, and the banner offers the way
        // back.
        term.write('\r\n\x1b[31m[Connection lost]\x1b[0m\r\n');
        markDropped(tabId);
        return;
      }
      // A container command that failed straight away, because the container
      // stopped or its image has no shell: closing would take the reason with
      // the tab. It stays, saying so, with Enter to try again; not retried on
      // its own, since it would fail the same way.
      const status = ev.payload.exit_status ?? 0;
      if (inContainer && ev.payload.reason === 'exited' && status !== 0 && Date.now() - boundAt < QUICK_FAILURE_MS) {
        term.write(`\r\n\x1b[31m[Ended with status ${status}]\x1b[0m\r\n`);
        markDropped(tabId, status);
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
          if (buf.length > 0) output(buf);
        }
      })
      .catch(() => {})
      .finally(() => {
        // Even if the replay failed, the queue has to drain or the session
        // shows nothing at all from here on.
        if (disposed) return;
        replayed = true;
        for (const buf of queued) output(buf);
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
    term.options.fontSize = fontSize;
    term.options.fontFamily = settings.font_family;
    term.options.cursorStyle = settings.cursor_style;
    term.options.cursorBlink = settings.cursor_blink;
    term.options.scrollback = settings.scrollback_lines;
    fitRef.current?.fit();
  }, [
    resolveTheme,
    fontSize,
    settings.font_family,
    settings.cursor_style,
    settings.cursor_blink,
    settings.scrollback_lines,
  ]);

  // Sixel and iTerm2 images. Loaded and dropped with the setting, since the
  // addon has no switch of its own; dropping it takes its images with it.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !settings.inline_images) return;
    const images = new ImageAddon(IMAGE_OPTIONS);
    term.loadAddon(images);
    return () => images.dispose();
  }, [settings.inline_images]);

  // The host's history, read once, the first time any of its tabs opens.
  useEffect(() => {
    if (serverId) void useAppStore.getState().loadCommandHistory(serverId);
  }, [serverId]);

  const history = useAppStore((s) => s.commandHistory[serverId]);
  useEffect(() => {
    suggestStateRef.current = { enabled: settings.autosuggest, history: history ?? [] };
    suggesterRef.current?.refresh();
  }, [settings.autosuggest, history]);

  // The rules and the colours they resolve to. Compiled here, once per
  // change, rather than on every pass over the output.
  useEffect(() => {
    const theme = resolveTheme();
    const palette: Record<string, string | undefined> = {};
    for (const name of HIGHLIGHT_COLORS) palette[name] = theme[name];
    highlightStateRef.current = {
      enabled: settings.highlight_enabled,
      rules: compileRules(settings.highlight_rules),
      palette,
    };
    highlighterRef.current?.refresh();
  }, [resolveTheme, settings.highlight_enabled, settings.highlight_rules]);

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

  // Ctrl+wheel zooms this tab. Not passive, because without preventDefault
  // the webview zooms the whole window underneath, which moves every panel
  // and cannot be undone from the terminal.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomSession(tabId, e.deltaY < 0 ? 1 : -1);
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

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
      style={{
        display: visible ? 'flex' : 'none',
        // A dragged split gives each pane a share of the row; without one
        // they all grow equally, which is what flex: 1 already does.
        ...(width !== undefined ? { flex: `0 0 ${width}%` } : null),
        '--term-bg': resolveTheme().background,
      } as React.CSSProperties}
      onMouseDown={() => { if (!focused) setActiveTab(tabId); }}
    >
      {resizer}
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
            title={hint('Previous match (Shift+Enter)')}
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
            title={hint('Next match (Enter)')}
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
            title={hint('Close (Escape)')}
            onClick={closeSearch}
          >
            ✕
          </button>

          {searchError && <p className="term-search-detail">{searchError}</p>}
        </div>
      )}

      {transfer && (
        <div className="zmodem-overlay">
          <div className="zmodem-row">
            <span className="zmodem-text">
              {transfer.direction === 'receive' ? 'Receiving' : 'Sending'} {transfer.name}
              {transfer.fileCount && transfer.fileCount > 1 ? ` (${transfer.fileIndex} of ${transfer.fileCount})` : ''}
            </span>
            <span className="zmodem-size">
              {formatSize(transfer.done)}{transfer.total !== null ? ` of ${formatSize(transfer.total)}` : ''}
            </span>
            <button className="btn-secondary btn-sm" onClick={() => zmodemRef.current?.cancel()} title={hint('Ctrl+C')}>
              Cancel
            </button>
          </div>
          {transfer.total ? (
            <progress className="zmodem-bar" value={transfer.done} max={transfer.total} />
          ) : (
            <progress className="zmodem-bar" />
          )}
        </div>
      )}

      {zmodemPick && (
        <FilePickerModal
          mode={zmodemPick.mode === 'folder' ? 'folder' : 'open'}
          multiple={zmodemPick.mode === 'files'}
          title={zmodemPick.mode === 'folder' ? 'Save the files the host is sending in…' : 'Send files to the host'}
          startDir={zmodemPick.startDir}
          confirmLabel={zmodemPick.mode === 'folder' ? 'Save here' : 'Send'}
          onCancel={() => { zmodemPick.resolve(null); setZmodemPick(null); }}
          onChoose={(path) => { zmodemPick.resolve(path); setZmodemPick(null); }}
          onChooseMany={(paths) => { zmodemPick.resolve(paths); setZmodemPick(null); }}
        />
      )}

      {tab.status === 'dropped' && (
        // Over the terminal rather than in place of it: the scrollback is the
        // point of keeping the tab, and it stays readable behind this.
        <div className="term-dropped">
          <div className="term-dropped-row">
            <span className="term-dropped-text">
              {tab.ended_with !== undefined ? `The command ended with status ${tab.ended_with}.` : 'Connection lost.'}
              {tab.quick_info && ' A quick connection cannot be reopened without the credentials typed for it.'}
              {retrying && !tab.reconnecting && countdown !== null && ` Trying again in ${countdown}s (attempt ${tab.retryAttempt ?? 1}).`}
              {tab.gaveUpAfter !== undefined && ` Gave up after ${tab.gaveUpAfter} ${tab.gaveUpAfter === 1 ? 'try' : 'tries'}.`}
            </span>
            {retrying && (
              <button className="btn-secondary btn-sm" onClick={() => stopRetrying(tabId)}>Stop</button>
            )}
            {!tab.quick_info && (
              <button
                className="btn-primary btn-sm"
                disabled={tab.reconnecting}
                onClick={() => { stopRetrying(tabId); void reconnectSession(tabId); }}
              >
                {tab.reconnecting ? 'Reconnecting…' : retrying ? 'Try now' : tab.ended_with !== undefined ? 'Run again' : 'Reconnect'}
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
      {/* Mounted as long as it is wanted, session or not, so a drop and a
          reconnect do not resize the terminal twice. */}
      {monitorShown && <MonitorBar sessionId={sessionId} visible={visible} />}
    </div>
  );
}
