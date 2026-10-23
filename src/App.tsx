import { useEffect, useState, useRef } from 'react';
import * as ipc from './ipc';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from './store/appStore';
import { useAppChrome } from './useAppChrome';
import { detachTab, mirrorOf, runDetachedAction, takeBack, windowLabel, type DetachedAction } from './detach';
import { setLocalPlatform } from './paths';
import { useIdleLock } from './hooks/useIdleLock';
import { useBackgroundLock } from './hooks/useBackgroundLock';
import { useAndroidKeepAlive, useVolumeZoom } from './hooks/useAndroidBackground';
import { useAndroidLaunch } from './hooks/useAndroidLaunch';
import type { AndroidLaunch, AuthPromptEvent, Codeprint, HostKeyPromptEvent, SessionTab, TunnelClosed, VaultStatus } from './types';
import { fill } from './snippets';
import { zoomPercent } from './zoom';
import { activityChip, anyBusy } from './activity';
import { parseSSHInput, parseSshUrl } from './sshInput';
import { readTabDrag, tabDragPayload } from './dragPayload';
import { usePromptQueue } from './usePromptQueue';
import { useTranscript } from './useTranscript';
import { useDragResize } from './components/shared/useDragResize';
import { useHint } from './components/shared/useHint';
import { evenAt, evenWidths, resizeAt, widthAt } from './paneSizes';
import { MAX_SPLIT } from './store/slices/splits';
import { WINDOW_ACTIONS, actionFor, resolve as resolveShortcuts, tabIndexFor } from './shortcuts';
import CommandPalette from './components/CommandPalette';
import SnippetPromptModal from './components/SnippetPromptModal';
import FilePickerModal from './components/FilePickerModal';
import RecordingsPanel from './components/RecordingsPanel';
import HostKeyPrompt from './components/HostKeyPrompt';
import AuthPromptModal from './components/AuthPromptModal';
import Sidebar from './components/Sidebar';
import UnlockScreen from './components/UnlockScreen';
import FirstRunSetup from './components/FirstRunSetup';
import TerminalView from './components/TerminalView';
import ConnectingView from './components/ConnectingView';
import HostsPanel from './components/HostsPanel';
import KeychainPanel from './components/KeychainPanel';
import KnownHostsPanel from './components/KnownHostsPanel';
import SettingsPanel from './components/SettingsPanel';
import ThemeEditorPanel from './components/ThemeEditorPanel';
import SftpPanel from './components/sftp/SftpPanel';
import ServerForm from './components/ServerForm';
import TerminalSidebar from './components/TerminalSidebar';
import ContainersPanel from './components/ContainersPanel';
import PortForwardingPanel from './components/PortForwardingPanel';
import ContextMenu from './components/shared/ContextMenu';
import Modal from './components/shared/Modal';
import PassphraseInput from './components/shared/PassphraseInput';
import { tabLabel } from './tabName';
import PortalDropdown from './components/shared/PortalDropdown';
import { isAndroid } from './platform';
import { setBackFallback, useBackClose } from './backStack';
import TerminalKeyBar, { KEYBAR_EVENT, type KeyBarKey } from './components/TerminalKeyBar';
import ShareToTerminalModal from './components/ShareToTerminalModal';

export default function App() {
  const {
    loadAll, loadError, actionError, setActionError, sessions, activeTabId, setActiveTab, removeSession,
    renameSession, toggleBroadcast, openInSftp, sendInput, toggleLogging, toggleRecording, savedRecording, setSavedRecording, playRecording, openLocalShell, splitGroup, splitWith, unsplit, openSession, quickConnect, servers, settings, keys,
    zoomSession, resetZoom, sessionZoom, splitWidths, setSplitWidths, sessionActivity,
    clearForLock,
  } = useAppStore();

  const chrome = useAppChrome();

  // 'new' is the Add Host drawer: no record to find, so the form opens empty.
  const [editServerId, setEditServerId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // On a narrow screen the sidebar is a drawer over the page.
  const [navOpen, setNavOpen] = useState(false);
  // A codeprint picked in the palette, waiting for its placeholders.
  const [snippet, setSnippet] = useState<Codeprint | null>(null);
  const [quickInput, setQuickInput] = useState('');
  const [quickParsed, setQuickParsed] = useState<{ user: string; host: string; port: number } | null>(null);
  const [quickPassword, setQuickPassword] = useState('');
  const [quickKeyId, setQuickKeyId] = useState('');
  const quickPasswordRef = useRef<HTMLInputElement>(null);
  const quickInputRef = useRef<HTMLInputElement>(null);
  // Text shared from another Android app, waiting for a terminal to go to.
  const [shareText, setShareText] = useState<string | null>(null);
  const [termSidebarOpen, setTermSidebarOpen] = useState(false);
  useBackClose(termSidebarOpen ? () => setTermSidebarOpen(false) : undefined);
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; session: SessionTab } | null>(null);
  const [tabDragOver, setTabDragOver] = useState(false);
  const transcript = useTranscript(setActionError);
  const startDrag = useDragResize();
  const hint = useHint();
  const activeIsSession = sessions.some((s) => s.tab_id === activeTabId);
  const activeDetached = sessions.some((s) => s.tab_id === activeTabId && s.detached);

  // A running command's chip counts up, so the strip re-renders while
  // anything is running and stops the moment nothing is. Nothing ticks on an
  // idle window, which is most of them.
  const [, setTick] = useState(0);
  const busy = anyBusy(sessionActivity, Date.now());
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  /** The tab's or pane's "still running" chip, where there is one to show. */
  function activityFor(tabId: string) {
    const chip = activityChip(sessionActivity[tabId], Date.now());
    if (!chip) return null;
    return <span className={`tab-activity tab-activity-${chip.kind}`} title={hint(chip.title)}>{chip.text}</span>;
  }
  const splitShown = activeTabId !== null && splitGroup.includes(activeTabId);

  // Back with nothing open steps back to Hosts, and from Hosts leaves the app.
  useEffect(() => {
    setBackFallback({
      can: () => activeTabId !== 'hosts' && activeTabId !== null,
      step: () => setActiveTab('hosts'),
    });
  }, [activeTabId, setActiveTab]);

  /**
   * Drags the boundary to the left of pane `index`.
   *
   * The same shape as the SFTP column resizer: percentages, zero-sum against
   * the neighbour, window listeners so the pointer can leave the handle, and
   * the body's cursor held for the duration. The state is written behind a
   * frame, so a drag costs each terminal one refit per frame rather than one
   * per mouse event; xterm refits itself from its own ResizeObserver.
   */
  function startPaneResize(index: number, e: React.MouseEvent) {
    const row = (e.currentTarget as HTMLElement).closest('.term-area');
    const startWidths = splitWidths.length === splitGroup.length
      ? splitWidths
      : evenWidths(splitGroup.length);
    startDrag(e, row?.getBoundingClientRect().width ?? 1, (delta) => {
      setSplitWidths(resizeAt(startWidths, index, delta));
    });
  }

  /**
   * The handle over a pane's left edge, for every pane but the first.
   *
   * Inside the pane rather than between panes: the separator between two
   * panes is drawn by an adjacent-sibling rule, which an element in between
   * would break.
   */
  function paneResizer(index: number) {
    if (index <= 0) return undefined;
    return (
      <div
        className="pane-resizer"
        title={hint('Drag to resize. Double-click to share these two evenly.')}
        onMouseDown={(e) => startPaneResize(index, e)}
        onDoubleClick={(e) => {
          e.stopPropagation();
          // This divider only: with three panes, evening the whole row would
          // move a boundary nobody touched.
          const current = splitWidths.length === splitGroup.length
            ? splitWidths
            : evenWidths(splitGroup.length);
          setSplitWidths(evenAt(current, index));
        }}
      />
    );
  }

  function paneHeader(s: SessionTab, focused: boolean) {
    return (
      <div className={`pane-header${focused ? ' pane-header-focused' : ''}`}>
        <span className="pane-header-title">{tabLabel(s)}</span>
        {activityFor(s.tab_id)}
        <button
          className="pane-header-close"
          title={hint('Remove from split')}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => unsplit(s.tab_id)}
        >
          &#10005;
        </button>
      </div>
    );
  }
  const [renameValue, setRenameValue] = useState('');
  /** The tab whose name is being edited, which happens in the strip itself. */
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Emitted globally rather than per connect, so one modal of each kind
  // serves terminal sessions, SFTP, tunnels and OS detection alike.
  const [hostKeyPrompts, dismissHostKeyPrompt] = usePromptQueue<HostKeyPromptEvent>('host-key-prompt');
  const [authPrompts, dismissAuthPrompt] = usePromptQueue<AuthPromptEvent>('auth-prompt');

  // Nothing is loaded until the vault is open. While locked the backend holds
  // no key, so loadAll would fail on every call anyway; gating it here keeps
  // the unlock screen from flashing a half populated app behind itself.
  const [vault, setVault] = useState<VaultStatus | null>(null);
  // The saved data has been read since the vault last opened.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    ipc.vaultStatus()
      .then((v) => {
        setVault(v);
        if (!v.locked) void loadAll().then(() => setLoaded(true));
      })
      .catch(() => setVault({ locked: false, setup_required: false, keyring_available: false, keyring_locked: false, error: null, biometric: false, pin: false }));
    // `loadAll` is a store action, created once with the store, so naming it
    // does not make this run again.
  }, [loadAll]);

  const opened = () => {
    setVault({ locked: false, setup_required: false, keyring_available: false, keyring_locked: false, error: null, biometric: false, pin: false });
    void loadAll().then(() => setLoaded(true));
  };

  /**
   * Asks the backend to close the vault. The shortcut and the idle timeout
   * come here; the settings button calls the same command. What happens on
   * this side happens in the `vault-locked` listener below, which is also
   * how a lock the backend started on its own, before sleep, arrives. One
   * path for every way of locking.
   */
  const lockNow = () =>
    ipc.lockVault().catch((e) => {
      // No passphrase set, which the settings screen explains at length. Said
      // once here so a shortcut that did nothing is not a mystery.
      setActionError(String(e));
    });

  // The vault is closed, whoever closed it. The backend has dropped the key
  // and the data; this drops the copies and shows the unlock screen.
  // Sessions stay, their shells still running behind it.
  useEffect(() => {
    const unlisten = listen('vault-locked', () => {
      clearForLock();
      setLoaded(false);
      setVault((v) => ({
        ...(v ?? { setup_required: false, keyring_available: false, keyring_locked: false, error: null, biometric: false, pin: false }),
        locked: true,
      }));
      // Then what can open it now: a fingerprint or PIN turned on since
      // launch is not in the status read then.
      ipc.vaultStatus().then(setVault).catch(() => {});
    });
    return () => { unlisten.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useIdleLock(vault && !vault.locked ? settings.auto_lock_minutes : 0, () => { void lockNow(); });
  // Quietly: with no passphrase there is nothing to lock with, and the
  // setting says so where it is chosen.
  useBackgroundLock(
    isAndroid && vault && !vault.locked ? settings.background_lock_minutes : null,
    () => { ipc.lockVault().catch(() => {}); },
  );
  useAndroidKeepAlive();
  const restoringTabs = useAppStore((s) => s.restoringTabs);
  useAndroidLaunch(!!vault && !vault.locked && loaded && !restoringTabs, handleLaunch);
  useVolumeZoom(!!vault && !vault.locked && activeIsSession && !activeDetached);

  useEffect(() => {
    const unlisten = listen<TunnelClosed>('tunnel-closed', (e) => {
      useAppStore.getState().tunnelDropped(e.payload.pf_id);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Asked once and never again: local paths are separated differently on
  // Windows, and every breadcrumb and rename target is built from that. Before
  // the answer arrives the app assumes POSIX, which is what it always did.
  useEffect(() => {
    ipc.platform().then(setLocalPlatform).catch(() => {});
  }, []);

  // A tab's window has gone, however it went: its tab comes back here.
  useEffect(() => {
    const unlisten = listen<string>('detached-gone', (e) => { void takeBack(e.payload); });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // What a tab's window asks for that only this one can do.
  useEffect(() => {
    const unlisten = listen<DetachedAction>('detached-action', (e) => {
      runDetachedAction(e.payload);
      // The SFTP panel is in this window, so this window is where to look.
      if (e.payload.action === 'openInSftp') getCurrentWindow().setFocus().catch(() => {});
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  // Keeps each tab's window drawing what this one would: its tab, the
  // settings, the hosts and the themes, sent whenever any of them changes.
  // A tab that has only just gone out is skipped; it took all of this with it.
  useEffect(() => useAppStore.subscribe((s, prev) => {
    for (const tab of s.sessions) {
      if (!tab.detached) continue;
      const before = prev.sessions.find((t) => t.tab_id === tab.tab_id);
      if (!before?.detached) continue;
      const same = before === tab && s.settings === prev.settings && s.servers === prev.servers
        && s.customThemes === prev.customThemes
        && s.sessionThemeOverrides[tab.tab_id] === prev.sessionThemeOverrides[tab.tab_id];
      if (!same) void emitTo(windowLabel(tab.tab_id), 'detached-sync', mirrorOf(s, tab)).catch(() => {});
    }
  }), []);

  /** Moves a tab into a window of its own; the banner says why when it could not. */
  function moveToWindow(tabId: string) {
    detachTab(tabId).catch((e) => setActionError(`Could not move the tab to a new window: ${String(e)}`));
  }

  /** Asks a tab's window to give its tab back, the same as closing it. */
  function bringBack(tabId: string) {
    void emitTo(windowLabel(tabId), 'detached-reattach', tabId).catch(() => {});
  }

  function handleCloseTab(tabId: string, e: React.MouseEvent) {
    e.stopPropagation();
    const session = sessions.find((s) => s.tab_id === tabId);
    // A dropped tab has no session to close; the store entry is all there is.
    if (session?.session_id) ipc.sshDisconnect(session.session_id).catch(() => {});
    removeSession(tabId);
  }

  // Read through a ref by the key handler below, which is bound once and
  // would otherwise see the sessions and active tab of its first render.
  const tabsRef = useRef({ sessions, activeTabId });
  tabsRef.current = { sessions, activeTabId };

  // Same reason: the bindings change while the listener stays the one that
  // was bound on the first render.
  const shortcutsRef = useRef(resolveShortcuts(settings.shortcuts));
  shortcutsRef.current = resolveShortcuts(settings.shortcuts);

  /**
   * Every window-level shortcut, bindings from the settings.
   *
   * Capture phase, and the event is stopped there rather than only
   * defaulted: xterm's key handler does not look at defaultPrevented, and
   * let through, Ctrl+PageUp turned into the shell receiving "5~". The
   * terminal's own three chords are matched in TerminalView, after this
   * handler has had its turn, so a chord bound in both places acts here.
   *
   * Tab cycling is over session tabs only, in strip order, wrapping; from a
   * fixed tab, next lands on the first session and previous on the last.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = actionFor(e, shortcutsRef.current, WINDOW_ACTIONS);
      if (action === null) return;
      const { sessions: tabs, activeTabId: active } = tabsRef.current;
      const idx = tabs.findIndex((t) => t.tab_id === active);
      // The tab from the ref, not from closeTab and friends: those read the
      // sessions of the render they were made in, and this listener was
      // made once.
      const current = idx >= 0 ? tabs[idx] : undefined;
      e.preventDefault();
      e.stopPropagation();

      switch (action) {
        case 'next-tab':
        case 'prev-tab': {
          if (tabs.length === 0) return;
          const next = action === 'next-tab';
          const target = idx < 0
            ? (next ? 0 : tabs.length - 1)
            : (idx + (next ? 1 : tabs.length - 1)) % tabs.length;
          setActiveTab(tabs[target].tab_id);
          return;
        }
        case 'palette':
          setPaletteOpen((open) => !open);
          return;
        case 'zoom-in':
          if (current) zoomSession(current.tab_id, 1);
          return;
        case 'zoom-out':
          if (current) zoomSession(current.tab_id, -1);
          return;
        case 'zoom-reset':
          if (current) resetZoom(current.tab_id);
          return;
        case 'lock-vault':
          void lockNow();
          return;
        case 'duplicate-tab':
          // A quick connection has no host record to open again.
          if (current?.kind === 'local') void openLocalShell();
          else if (current && current.server_id) openSession(current.server_id, undefined, current.container);
          return;
        case 'local-shell':
          if (!isAndroid) void openLocalShell();
          return;
        case 'toggle-broadcast':
          if (current) toggleBroadcast(current.tab_id);
          return;
        case 'close-tab':
          if (!current) return;
          if (current.session_id) ipc.sshDisconnect(current.session_id).catch(() => {});
          removeSession(current.tab_id);
          return;
        default: {
          // The numbered tabs, which are one action each so that each can be
          // rebound on its own.
          const at = tabIndexFor(action, tabs.length);
          if (at !== null) setActiveTab(tabs[at].tab_id);
          return;
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Closing the palette hands the keyboard back to the terminal. Focus sits
   * on xterm's hidden textarea, and TerminalView only re-focuses when its
   * `focused` prop changes, which it has not; so the element is asked
   * directly, after the palette has gone.
   */
  function closePalette() {
    setPaletteOpen(false);
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLTextAreaElement>('.terminal-pane-focused .xterm-helper-textarea')
        ?? document.querySelector<HTMLTextAreaElement>('.terminal-pane .xterm-helper-textarea');
      target?.focus();
    });
  }

  /** Sends a codeprint the palette picked to the tab that was active. */
  function sendCodeprint(text: string) {
    const tab = tabsRef.current.activeTabId;
    if (!tab) return;
    sendInput(tab, Array.from(new TextEncoder().encode(text + '\n')));
    closePalette();
  }

  function handleTabContextMenu(e: React.MouseEvent, session: SessionTab) {
    e.preventDefault();
    e.stopPropagation();
    setTabCtx({ x: e.clientX, y: e.clientY, session });
  }

  /** Tabs that `tabId` could be split with from its menu: none once the group is full. */
  function splitCandidates(tabId: string): SessionTab[] {
    const group = splitGroup.includes(tabId) ? splitGroup : [tabId];
    if (group.length >= MAX_SPLIT) return [];
    return sessions.filter((t) => !t.detached && !group.includes(t.tab_id));
  }

  function handleDuplicate(session: SessionTab) {
    setTabCtx(null);
    if (session.kind === 'local') void openLocalShell();
    else openSession(session.server_id, undefined, session.container);
  }

  /**
   * What the Android app was opened for: a launcher shortcut's host, an
   * ssh:// link, or text shared from another app.
   *
   * A link to a host that is saved opens it as saved, credentials and all.
   * Any other link stops at the quick connect prompt: a link can name a
   * host, but never says how to log in to it.
   */
  function handleLaunch(launch: AndroidLaunch) {
    const { servers: saved, identities, sessions: tabs } = useAppStore.getState();
    if (launch.kind === 'host') {
      // A shortcut is a way to the host, not a request for another tab on
      // it: one already open (restored at launch, say) is shown instead.
      const open = tabs.find((t) => t.server_id === launch.id && !t.container && !t.detached);
      if (open) setActiveTab(open.tab_id);
      else if (saved.some((s) => s.id === launch.id)) void openSession(launch.id);
      else setActionError('That host no longer exists.');
      return;
    }
    if (launch.kind === 'share') {
      const open = tabs.filter((t) => t.status === 'connected' && !t.detached);
      if (open.length === 0) setActionError('Open a session first, then share the text again.');
      else setShareText(launch.text);
      return;
    }
    const url = parseSshUrl(launch.url);
    if (!url) {
      setActionError(`Not an SSH link BifroSSH can open: ${launch.url}`);
      return;
    }
    const userOf = (s: (typeof saved)[number]) =>
      s.username ?? identities.find((i) => i.id === s.identity_id)?.username ?? null;
    const match = saved.find((s) =>
      s.host.toLowerCase() === url.host.toLowerCase()
      && s.port === url.port
      && (!url.user || userOf(s) === url.user));
    if (match) {
      void openSession(match.id);
      return;
    }
    setActiveTab('hosts');
    if (url.user) {
      setQuickParsed({ user: url.user, host: url.host, port: url.port });
      setQuickPassword('');
      setQuickKeyId('');
      setTimeout(() => quickPasswordRef.current?.focus(), 50);
    } else {
      // No user in the link: the box is filled in up to it, with the cursor
      // where the name goes.
      setQuickInput(`@${url.host}${url.port !== 22 ? ` -p ${url.port}` : ''}`);
      setTimeout(() => {
        quickInputRef.current?.focus();
        quickInputRef.current?.setSelectionRange(0, 0);
      }, 50);
    }
  }

  /** Pastes the shared text into a tab, once it is the focused terminal. */
  function pasteShared(tabId: string) {
    const text = shareText;
    setShareText(null);
    if (text === null) return;
    setActiveTab(tabId);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent<KeyBarKey>(KEYBAR_EVENT, { detail: { paste: text } }));
    }, 100);
  }

  function handleQuickSubmit(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const parsed = parseSSHInput(quickInput);
    if (!parsed) return;
    if (parsed.password) {
      setQuickInput('');
      quickConnect(parsed.host, parsed.port, parsed.user, 'password', parsed.password);
    } else {
      setQuickParsed({ user: parsed.user, host: parsed.host, port: parsed.port });
      setQuickPassword('');
      setQuickKeyId('');
      setTimeout(() => quickPasswordRef.current?.focus(), 50);
    }
  }

  function submitQuickAuth() {
    if (!quickParsed) return;
    const authType = quickKeyId ? 'key' : 'password';
    const authValue = quickKeyId || quickPassword;
    if (!authValue) return;
    setQuickParsed(null);
    setQuickInput('');
    quickConnect(quickParsed.host, quickParsed.port, quickParsed.user, authType, authValue);
  }

  /**
   * Renaming happens in the tab itself, whether it was asked for by a
   * double-click or from the menu: one place the name is edited means one
   * shape to learn, and the name is edited where it is read.
   */
  function startRename(session: SessionTab, e?: React.MouseEvent) {
    e?.stopPropagation();
    setRenameValue(tabLabel(session));
    setEditingTabId(session.tab_id);
    // After the input exists. The file list does the same, for the same reason.
    setTimeout(() => renameInputRef.current?.select(), 30);
  }

  function commitRename() {
    // An empty name is not a refusal to rename: it puts the tab back on the
    // host's own name, which is the only way to undo one.
    if (editingTabId) renameSession(editingTabId, renameValue);
    setEditingTabId(null);
  }

  // Held back until vault_status answers, which is one synchronous read on the
  // backend, so this is a frame rather than a spinner's worth of waiting.
  if (!vault) return null;
  // Nothing behind the screen yet, or nothing that can be shown: the screen
  // is all there is.
  if (vault.error || vault.setup_required || (vault.locked && sessions.length === 0)) {
    return (
      <div className={chrome.className} style={chrome.style}>
        {vault.setup_required ? (
          <FirstRunSetup keyringAvailable={vault.keyring_available} onReady={opened} />
        ) : (
          <UnlockScreen key={`${vault.biometric}-${vault.pin}`} fatal={vault.error} keyringLocked={vault.keyring_locked} biometric={vault.biometric} pin={vault.pin} onUnlocked={opened} />
        )}
      </div>
    );
  }

  return (
    <div className={chrome.className} style={chrome.style}>
      {/* A lock with sessions open covers the app rather than replacing it,
          so the terminals stay mounted: unmounting one disposes its xterm and
          the scrollback with it, and drops its output listener, so nothing
          the shell printed during the lock would be seen. The overlay is
          opaque and takes every pointer event; the unlock field has focus.
          Keyed on the ways in, so a status read after the lock that finds
          a fingerprint or PIN starts the screen again with them. */}
      {vault.locked && (
        <div className="lock-overlay">
          <UnlockScreen key={`${vault.biometric}-${vault.pin}`} fatal={null} keyringLocked={vault.keyring_locked} biometric={vault.biometric} pin={vault.pin} onUnlocked={opened} />
        </div>
      )}
      {/* Inert while locked: without it, Tab from the passphrase field walks
          into the sidebar behind the overlay and Enter presses whatever it
          lands on. `display: contents` keeps the flex layout the two children
          were laid out by. */}
      <div className="app-body" inert={vault.locked || undefined}>
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <div className="main">
        {loadError && (
          <div className="load-error-banner">
            <span>
              Saved data could not be read, so this may not be showing everything.
              {' '}{loadError}
            </span>
            <button className="btn-secondary btn-sm" onClick={() => loadAll()}>Try again</button>
          </div>
        )}
        {savedRecording && (
          <div className="notice-banner">
            <span>Recording saved to {savedRecording}</span>
            <button
              className="btn-secondary btn-sm"
              onClick={() => { playRecording(savedRecording); setSavedRecording(null); }}
            >
              Play
            </button>
            <button
              className="load-error-dismiss"
              aria-label="Dismiss"
              onClick={() => setSavedRecording(null)}
            >
              ✕
            </button>
          </div>
        )}
        {actionError && (
          <div className="load-error-banner">
            <span>{actionError}</span>
            <button
              className="load-error-dismiss"
              aria-label="Dismiss"
              onClick={() => setActionError(null)}
            >
              ✕
            </button>
          </div>
        )}
        {(activeTabId === 'hosts' || activeTabId === null) && <div className="quick-connect-bar">

          <input
            ref={quickInputRef}
            className="quick-connect-input"
            value={quickInput}
            onChange={(e) => setQuickInput(e.target.value)}
            onKeyDown={handleQuickSubmit}
            placeholder="ssh user@host -p 22 -pw password"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            className="btn-primary btn-sm"
            onClick={() => handleQuickSubmit({ key: 'Enter' } as React.KeyboardEvent<HTMLInputElement>)}
          >
            Quick Connect
          </button>
          {!isAndroid && <button
            className="btn-secondary btn-sm quick-local-shell"
            onClick={() => void openLocalShell()}
            title={hint('Open a shell on this computer')}
          >
            <span className="quick-local-shell-glyph">&gt;_</span> Local Shell
          </button>}
        </div>}
        {/* Always rendered, empty or not. Appearing on the first connect, it
            pushed everything below it down the page. */}
        <div className={`tab-bar${sessions.length === 0 ? ' tab-bar-empty' : ''}`}>
          {/* Narrow screens only: the drawer's handle, and the palette, which
              a touch keyboard has no Ctrl+K to open. */}
          <div className="tab-bar-narrow">
            <button className="tab-bar-icon" aria-label="Menu" onClick={() => setNavOpen(true)}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="4" y1="6" x2="20" y2="6"/>
                <line x1="4" y1="12" x2="20" y2="12"/>
                <line x1="4" y1="18" x2="20" y2="18"/>
              </svg>
            </button>
            <button className="tab-bar-icon" aria-label="Command palette" onClick={() => setPaletteOpen(true)}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7"/>
                <line x1="16.5" y1="16.5" x2="21" y2="21"/>
              </svg>
            </button>
          </div>
          {sessions.map((s) => (
              <div
                key={s.tab_id}
                className={`tab ${activeTabId === s.tab_id ? 'tab-active' : ''}${s.detached ? ' tab-detached' : ''}`}
                onClick={() => setActiveTab(s.tab_id)}
                onContextMenu={(e) => handleTabContextMenu(e, s)}
                draggable={!isAndroid}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', tabDragPayload(s.tab_id));
                  e.dataTransfer.effectAllowed = 'move';
                }}
              >
                {s.detached && <span className="tab-detached-mark" title={hint('In a window of its own')}>↗</span>}
                {splitGroup.includes(s.tab_id) && <span className="tab-split" title={hint('Shown in a split')}>⊟</span>}
                {s.logging === 'tab' && <span className="tab-logging" title={hint('Output is being logged to a file')}>●</span>}
                {s.container?.sudo && <span className="tab-sudo" title="Running as root with sudo">SUDO</span>}
                {s.recording && <span className="tab-recording" title={hint('Being recorded')}>REC</span>}
                {s.broadcast && (
                  <span className="tab-broadcast" title={hint('Broadcasting: input also goes to every other tab marked the same way')}>⇶</span>
                )}
                {editingTabId === s.tab_id ? (
                  <input
                    ref={renameInputRef}
                    className="tab-rename-input"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setEditingTabId(null);
                    }}
                  />
                ) : (
                  <span className="tab-title" onDoubleClick={(e) => startRename(s, e)}>
                    {tabLabel(s)}
                  </span>
                )}
                {activityFor(s.tab_id)}
                {/* A tab whose text is a different size than the rest says
                    why, and clicking it puts the tab back on the setting. */}
                {zoomPercent(sessionZoom[s.tab_id], settings.font_size) !== null && (
                  <button
                    className="tab-zoom"
                    title={hint('Zoom for this tab. Click to reset.')}
                    onClick={(e) => { e.stopPropagation(); resetZoom(s.tab_id); }}
                  >
                    {zoomPercent(sessionZoom[s.tab_id], settings.font_size)}%
                  </button>
                )}
                <button className="tab-close" onClick={(e) => handleCloseTab(s.tab_id, e)}>&#10005;</button>
              </div>
            ))}
            {activeIsSession && !activeDetached && (
              <button
                className={`tab-sidebar-toggle${termSidebarOpen ? ' active' : ''}`}
                onClick={() => setTermSidebarOpen((v) => !v)}
                title={hint('Toggle terminal sidebar')}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <line x1="15" y1="3" x2="15" y2="21"/>
                </svg>
              </button>
            )}
        </div>

        <div className="content">
          <div className="content-main">
          <div
            className={`term-area${activeIsSession ? '' : ' term-area-off'}${tabDragOver ? ' term-area-drop' : ''}`}
            onDragOver={(e) => {
              // Only the types are readable here, so any text drag is let
              // in; the drop itself checks it was a tab.
              if (!e.dataTransfer.types.includes('text/plain') || !activeIsSession) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              if (!tabDragOver) setTabDragOver(true);
            }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setTabDragOver(false); }}
            onDrop={(e) => {
              setTabDragOver(false);
              const dropped = readTabDrag(e.dataTransfer.getData('text/plain'));
              if (!dropped || !activeTabId || !activeIsSession) return;
              e.preventDefault();
              splitWith(activeTabId, dropped);
            }}
          >
          {sessions.map((s) => {
            const inSplit = splitGroup.includes(s.tab_id);
            const visible = activeTabId === s.tab_id || (splitShown && inSplit);
            const focused = activeTabId === s.tab_id;
            // Only a pane in the shown split has a share of the row; a tab
            // on its own has the whole of it.
            const paneAt = splitShown && inSplit ? splitGroup.indexOf(s.tab_id) : -1;
            const paneWidth = paneAt >= 0 ? widthAt(splitWidths, paneAt, splitGroup.length) : undefined;
            const server = servers.find((srv) => srv.id === s.server_id)
              ?? (s.kind === 'local' ? {
                id: '', name: s.server_name, host: 'this computer', port: 0,
                identity_id: null, theme: null, connection_timeout: null, os: 'local',
                username: null, encrypted_password: null, key_id: null,
                auth_kind: null, proxy_jump: null, proxy_command: null, forward_agent: false, forward_x11: false, log_sessions: false, group: null, run_on_connect: null, hide_run_on_connect: true, notes: null, term: null, env: null, monitor: null, tags: [],
              } : undefined)
              ?? (s.quick_info ? {
                id: '', name: s.server_name,
                host: s.quick_info.host, port: s.quick_info.port,
                identity_id: null, theme: null, connection_timeout: null, os: '',
                username: s.quick_info.username, encrypted_password: null, key_id: null,
                auth_kind: null, proxy_jump: null, proxy_command: null, forward_agent: false, forward_x11: false, log_sessions: false, group: null, run_on_connect: null, hide_run_on_connect: true, notes: null, term: null, env: null, monitor: null, tags: [],
              } : undefined);

            if (s.detached) {
              // The terminal is in its own window. The tab stays here, so it
              // can be found, closed, or brought back.
              return (
                <div key={s.tab_id} className="term-detached" style={{ display: visible ? 'flex' : 'none' }}>
                  <p>{tabLabel(s)} is in a window of its own.</p>
                  <div className="term-detached-actions">
                    <button className="btn-primary btn-sm" onClick={() => { ipc.windowFocus(s.tab_id).catch(() => {}); }}>
                      Show window
                    </button>
                    <button className="btn-secondary btn-sm" onClick={() => bringBack(s.tab_id)}>
                      Bring back here
                    </button>
                  </div>
                </div>
              );
            }

            if (s.status === 'connecting' || s.status === 'error') {
              if (!server) return null;
              return (
                <div
                  key={s.tab_id}
                  className="term-connecting"
                  style={{
                    display: visible ? 'flex' : 'none',
                    ...(paneWidth !== undefined ? { flex: `0 0 ${paneWidth}%` } : null),
                  }}
                >
                  {paneResizer(paneAt)}
                  {splitShown && inSplit && paneHeader(s, focused)}
                  <ConnectingView
                    server={server}
                    logs={s.logs ?? []}
                    error={s.error}
                    onClose={() => removeSession(s.tab_id)}
                    onRetry={s.quick_info ? undefined
                      : s.kind === 'local' ? () => { removeSession(s.tab_id); void openLocalShell(); }
                        : () => { removeSession(s.tab_id); openSession(s.server_id, undefined, s.container); }}
                    onEditHost={s.quick_info || s.kind === 'local' ? undefined : () => setEditServerId(server.id)}
                  />
                </div>
              );
            }

            return (
              <TerminalView
                key={s.tab_id}
                tab={s}
                visible={visible}
                focused={focused}
                header={splitShown && inSplit ? paneHeader(s, focused) : undefined}
                resizer={paneResizer(paneAt)}
                width={paneWidth}
              />
            );
          })}
          </div>
          {isAndroid && activeIsSession && !activeDetached && <TerminalKeyBar />}

          {(activeTabId === 'hosts' || activeTabId === null) && <HostsPanel />}
          {activeTabId === 'containers' && <ContainersPanel />}
          {activeTabId === 'keychain' && <KeychainPanel />}
          <div style={{ display: activeTabId === 'sftp' ? 'contents' : 'none' }}><SftpPanel /></div>
          {activeTabId === 'knownhosts' && <KnownHostsPanel />}
          {activeTabId === 'recordings' && <RecordingsPanel />}
          {activeTabId === 'portforwarding' && <PortForwardingPanel />}
          {activeTabId === 'settings' && <SettingsPanel />}
          {activeTabId === 'theme-editor' && <ThemeEditorPanel />}
          </div>
          {termSidebarOpen && activeIsSession && !activeDetached && (
            <TerminalSidebar
              activeSessionId={activeTabId}
              onSent={isAndroid ? () => setTermSidebarOpen(false) : undefined}
            />
          )}
        </div>
      </div>

      {/* Not over the lock screen: it sits outside .app-body, so the inert
          that covers everything else would not cover it. */}
      {paletteOpen && !vault.locked && (
        <CommandPalette
          onClose={closePalette}
          onCodeprint={setSnippet}
          onAddHost={() => { setActiveTab('hosts'); setEditServerId('new'); }}
          onLock={() => { void lockNow(); }}
          onDetach={moveToWindow}
          onShowWindow={(tabId) => { ipc.windowFocus(tabId).catch(() => {}); }}
          onTranscript={(tabId, to) => {
            const session = sessions.find((t) => t.tab_id === tabId);
            if (!session) return;
            if (to === 'clipboard') void transcript.copy(session);
            else void transcript.save(session);
          }}
        />
      )}

      {transcript.saving && (
        <FilePickerModal
          mode="save"
          title="Save transcript"
          startDir={transcript.saving.startDir}
          defaultName={transcript.saving.name}
          extensions={['.txt']}
          onCancel={transcript.cancelSave}
          onChoose={(path) => { void transcript.write(path, transcript.saving!.text); }}
        />
      )}

      {shareText !== null && (
        <ShareToTerminalModal
          text={shareText}
          tabs={sessions.filter((t) => t.status === 'connected' && !t.detached)}
          onPick={pasteShared}
          onCancel={() => setShareText(null)}
        />
      )}

      {snippet && (
        <SnippetPromptModal
          title={snippet.name}
          command={snippet.command}
          onSubmit={(values) => { sendCodeprint(fill(snippet.command, values)); setSnippet(null); }}
          onCancel={() => setSnippet(null)}
        />
      )}

      {editServerId && (
        <ServerForm
          server={servers.find((s) => s.id === editServerId) ?? null}
          onClose={() => setEditServerId(null)}
        />
      )}

      {hostKeyPrompts.length > 0 && (
        <HostKeyPrompt
          key={hostKeyPrompts[0].request_id}
          event={hostKeyPrompts[0]}
          onResolved={dismissHostKeyPrompt}
        />
      )}

      {/* Host key first: it decides whether to talk to this server at all. */}
      {hostKeyPrompts.length === 0 && authPrompts.length > 0 && (
        <AuthPromptModal
          key={authPrompts[0].request_id}
          event={authPrompts[0]}
          onResolved={dismissAuthPrompt}
        />
      )}

      {quickParsed && (
        <Modal
          title={`${quickParsed.user}@${quickParsed.host}${quickParsed.port !== 22 ? `:${quickParsed.port}` : ''}`}
          className="quick-auth-modal"
          onClose={() => setQuickParsed(null)}
        >
          <div className="form-group">
            <label>Password</label>
            <PassphraseInput
              inputRef={quickPasswordRef}
              value={quickPassword}
              onChange={(v) => { setQuickPassword(v); if (v) setQuickKeyId(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submitQuickAuth(); if (e.key === 'Escape') setQuickParsed(null); }}
              placeholder="SSH password"
              disabled={!!quickKeyId}
            />
          </div>
          <div className="quick-auth-or">or use a stored key</div>
          <div className="picker quick-auth-keys">
            <PortalDropdown label={keys.find((k) => k.id === quickKeyId)?.name ?? 'Select key…'}>
              {(close) => (
                <>
                  {keys.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      className={`picker-item${quickKeyId === k.id ? ' selected' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setQuickKeyId(quickKeyId === k.id ? '' : k.id);
                        setQuickPassword('');
                        close();
                      }}
                    >
                      {k.name}
                    </button>
                  ))}
                  {keys.length === 0 && <div className="picker-empty">No keys stored</div>}
                </>
              )}
            </PortalDropdown>
          </div>
          <div className="modal-actions">
            <button className="btn-secondary btn-sm" onClick={() => setQuickParsed(null)}>Cancel</button>
            <button className="btn-primary btn-sm" onClick={submitQuickAuth} disabled={!quickPassword && !quickKeyId}>Connect</button>
          </div>
        </Modal>
      )}

      {tabCtx && (
        <ContextMenu x={tabCtx.x} y={tabCtx.y} onClose={() => setTabCtx(null)}>
          <>
              <button className="menu-item" onClick={() => handleDuplicate(tabCtx.session)}>
                Duplicate
              </button>
              <button className="menu-item" onClick={() => { startRename(tabCtx.session); setTabCtx(null); }}>
                Rename
              </button>
              {/* A quick connection has no saved host for the SFTP panel to open,
                  and a container's files are not the host's. */}
              {!tabCtx.session.quick_info && tabCtx.session.kind !== 'local' && !tabCtx.session.container && (
                <button className="menu-item" onClick={() => { openInSftp(tabCtx.session.server_id, '~'); setTabCtx(null); }}>
                  Open in SFTP
                </button>
              )}
              <button className="menu-item" onClick={() => { toggleBroadcast(tabCtx.session.tab_id); setTabCtx(null); }}>
                {tabCtx.session.broadcast ? '✓ ' : ''}Broadcast input
              </button>
              <button
                className="menu-item"
                disabled={!tabCtx.session.session_id}
                onClick={() => { toggleLogging(tabCtx.session.tab_id); setTabCtx(null); }}
              >
                {tabCtx.session.logging ? '✓ ' : ''}Log to file
              </button>
              <button
                className="menu-item"
                disabled={!tabCtx.session.session_id}
                onClick={() => { void toggleRecording(tabCtx.session.tab_id); setTabCtx(null); }}
              >
                {tabCtx.session.recording ? 'Stop recording' : 'Record session'}
              </button>
              {/* Logging starts at connect; this is what is already on
                  screen, scrollback included. That screen is in the other
                  window while the tab is out. */}
              {!tabCtx.session.detached && (
                <>
                  <button className="menu-item" onClick={() => { void transcript.copy(tabCtx.session); setTabCtx(null); }}>
                    Copy transcript
                  </button>
                  <button className="menu-item" onClick={() => { void transcript.save(tabCtx.session); setTabCtx(null); }}>
                    Save transcript…
                  </button>
                </>
              )}
              {tabCtx.session.detached ? (
                <>
                  <button className="menu-item" onClick={() => { ipc.windowFocus(tabCtx.session.tab_id).catch(() => {}); setTabCtx(null); }}>
                    Show its window
                  </button>
                  <button className="menu-item" onClick={() => { bringBack(tabCtx.session.tab_id); setTabCtx(null); }}>
                    Bring back to this window
                  </button>
                </>
              ) : !isAndroid && (
                <button
                  className="menu-item"
                  disabled={tabCtx.session.status !== 'connected' || !tabCtx.session.session_id}
                  onClick={() => { moveToWindow(tabCtx.session.tab_id); setTabCtx(null); }}
                >
                  Move to new window
                </button>
              )}
              {/* Dragging a tab onto the terminal splits it on a desktop;
                  a phone has no drag, so the menu offers each tab instead. */}
              {isAndroid && !tabCtx.session.detached && splitCandidates(tabCtx.session.tab_id).map((other) => (
                <button
                  key={other.tab_id}
                  className="menu-item"
                  onClick={() => {
                    splitWith(tabCtx.session.tab_id, other.tab_id);
                    setActiveTab(tabCtx.session.tab_id);
                    setTabCtx(null);
                  }}
                >
                  Split with {tabLabel(other)}
                </button>
              ))}
              {splitGroup.includes(tabCtx.session.tab_id) && (
                <button className="menu-item" onClick={() => { unsplit(tabCtx.session.tab_id); setTabCtx(null); }}>
                  Remove from split
                </button>
              )}
              <div className="menu-divider" />
              <button className="menu-item menu-item-danger" onClick={(e) => { handleCloseTab(tabCtx.session.tab_id, e); setTabCtx(null); }}>
                Close Connection
              </button>
            </>
        </ContextMenu>
      )}
      </div>
    </div>
  );
}

