import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store/appStore';
import { THEMES } from '../styles/themes';
import '@xterm/xterm/css/xterm.css';

interface Props {
  sessionId: string;
  serverId: string;
  active: boolean;
}

export default function TerminalView({ sessionId, serverId, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const { settings, servers, removeSession } = useAppStore();

  function effectiveThemeKey() {
    const server = servers.find((s) => s.id === serverId);
    return server?.theme ?? settings.theme;
  }

  useEffect(() => {
    if (!containerRef.current) return;

    const theme = THEMES[effectiveThemeKey()] ?? THEMES['bifrossh-dark'];
    const term = new Terminal({
      theme,
      fontSize: settings.font_size,
      fontFamily: settings.font_family,
      cursorStyle: settings.cursor_style as 'block' | 'underline' | 'bar',
      cursorBlink: settings.cursor_blink,
      scrollback: 10000,
      allowTransparency: false,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

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
          invoke('ssh_resize', { sessionId, cols, rows }).catch(() => {});
        }
      });
    });

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type === 'keydown' && ev.ctrlKey && ev.shiftKey) {
        if (ev.key === 'C') {
          const sel = term.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
          return false;
        }
        if (ev.key === 'V') {
          navigator.clipboard.readText().then((text) => {
            if (text) invoke('ssh_send_input', { sessionId, data: Array.from(new TextEncoder().encode(text)) }).catch(() => {});
          }).catch(() => {});
          return false;
        }
      }
      return true;
    });

    term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      invoke('ssh_send_input', { sessionId, data: bytes }).catch(() => {});
    });

    term.onResize(({ cols, rows }) => {
      invoke('ssh_resize', { sessionId, cols, rows }).catch(() => {});
    });

    term.onSelectionChange(() => {
      const pos = term.getSelectionPosition();
      if (!pos) return;
      const buf = term.buffer.active;
      // pos.end.y is 1-based buffer-absolute; cursor is baseY + cursorY (0-based) + 1
      const cursorAbsRow = buf.baseY + buf.cursorY + 1;
      if (pos.end.y > cursorAbsRow) term.clearSelection();
    });

    const unlistenOutput = listen<string>(`ssh-output:${sessionId}`, (ev) => {
      const buf = Uint8Array.from(atob(ev.payload), (c) => c.charCodeAt(0));
      if (buf.length > 0) term.write(buf);
    });

    const unlistenClose = listen(`ssh-closed:${sessionId}`, () => {
      term.writeln('\r\n\x1b[31mConnection closed.\x1b[0m');
      removeSession(sessionId);
    });

    return () => {
      unlistenOutput.then((fn) => fn());
      unlistenClose.then((fn) => fn());
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Apply theme/font changes without recreating the terminal
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const theme = THEMES[effectiveThemeKey()] ?? THEMES['bifrossh-dark'];
    term.options.theme = theme;
    term.options.fontSize = settings.font_size;
    term.options.fontFamily = settings.font_family;
    term.options.cursorStyle = settings.cursor_style as 'block' | 'underline' | 'bar';
    term.options.cursorBlink = settings.cursor_blink;
    fitRef.current?.fit();
  }, [settings, servers]);

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

  return (
    <div
      ref={containerRef}
      className="terminal-container"
      style={{ display: active ? 'flex' : 'none' }}
    />
  );
}
