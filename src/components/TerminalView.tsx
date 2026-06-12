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
  // Printable char bytes locally echoed, pending server confirmation
  const charTypeaheadRef = useRef<number[]>([]);
  // How many [BS SP BS] sequences to strip from server output
  const bsPendingRef = useRef(0);
  // Count of locally-echoed chars currently visible on screen
  const localCountRef = useRef(0);
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

    term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));

      // If ESC is present the whole batch is a control sequence (arrows, F-keys,
      // etc.). The bytes after ESC are often printable ASCII (e.g. '[A') but are
      // NOT characters to echo — skip local echo for the entire batch.
      if (bytes.includes(0x1b)) {
        localCountRef.current = 0;
      } else {
        for (const b of bytes) {
          if (b >= 0x20 && b <= 0x7e) {
            term.write(String.fromCharCode(b));
            charTypeaheadRef.current.push(b);
            localCountRef.current++;
          } else if ((b === 0x7f || b === 0x08) && localCountRef.current > 0) {
            // Separate BS suppression counter — keeps BS echoes out of the char
            // typeahead so a pending BS echo can't cause a char-echo mismatch.
            term.write('\b \b');
            bsPendingRef.current++;
            localCountRef.current--;
          } else {
            localCountRef.current = 0;
          }
        }
      }

      invoke('ssh_send_input', { sessionId, data: bytes }).catch(() => {});
    });

    term.onResize(({ cols, rows }) => {
      invoke('ssh_resize', { sessionId, cols, rows }).catch(() => {});
    });

    const unlistenOutput = listen<string>(`ssh-output:${sessionId}`, (ev) => {
      let buf = Uint8Array.from(atob(ev.payload), (c) => c.charCodeAt(0));

      // Strip leading char echoes (prefix match).
      const ct = charTypeaheadRef.current;
      let n = 0;
      while (n < buf.length && n < ct.length && buf[n] === ct[n]) n++;
      charTypeaheadRef.current = ct.slice(n);
      buf = buf.slice(n);

      // Char echoes and BS echoes can be interleaved (e.g. 'e' echo, BS echo, 'x' echo).
      // Alternate stripping BS sequences and char prefix echoes until nothing changes.
      let progress = true;
      while (progress && buf.length > 0) {
        progress = false;

        // Strip [BS SP BS] sequences
        while (bsPendingRef.current > 0 && buf.length >= 3
               && buf[0] === 0x08 && buf[1] === 0x20 && buf[2] === 0x08) {
          bsPendingRef.current--;
          buf = buf.slice(3);
          progress = true;
        }

        // Strip more char echoes
        const ct2 = charTypeaheadRef.current;
        let n2 = 0;
        while (n2 < buf.length && n2 < ct2.length && buf[n2] === ct2[n2]) n2++;
        if (n2 > 0) {
          charTypeaheadRef.current = ct2.slice(n2);
          buf = buf.slice(n2);
          progress = true;
        }
      }

      if (buf.length > 0) {
        // Server overrode our predictions — clear all local state.
        charTypeaheadRef.current = [];
        bsPendingRef.current = 0;
        localCountRef.current = 0;
        term.write(buf);
      }
    });

    const unlistenClose = listen(`ssh-closed:${sessionId}`, () => {
      charTypeaheadRef.current = [];
      bsPendingRef.current = 0;
      localCountRef.current = 0;
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
      setTimeout(() => {
        fitRef.current?.fit();
        termRef.current?.focus();
      }, 20);
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
