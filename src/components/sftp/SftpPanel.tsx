import { useState, useEffect, useRef } from 'react';
import * as ipc from '../../ipc';
import { useAppStore } from '../../store/appStore';
import type { FileEntry } from '../../types';
import { bookmarksFor, isBookmarked, labelFor } from '../../bookmarks';
import { freeName, localStyle, remoteStyle } from '../../paths';
import ConnectingView from '../ConnectingView';
import CompareDialog from './CompareDialog';
import ConflictDialog from './ConflictDialog';
import FileBrowser from './FileBrowser';
import HostPicker, { ConnectPrompt } from './HostPicker';
import MismatchDialog from './MismatchDialog';
import TransferQueue from './TransferQueue';
import { LOCAL_ICON, REMOTE_ICON } from './icons';
import { archiveTarget, bookmarkKey, browsing, canMove, emptySummary, transferKind } from './panes';
import { useCompare } from './useCompare';
import { useExternalDrop } from './useExternalDrop';
import { usePane, type Pane } from './usePane';
import { useTransferQueue } from './useTransferQueue';
import { isAndroid } from '../../platform';
import { StorageAccessNotice, useStorageAccess } from '../../storageAccess';

const closeConnectionActions = (onClose: () => void) => (
  <>
    <div className="menu-divider" />
    <button className="menu-item menu-item-danger" onClick={onClose}>
      Close Connection
    </button>
  </>
);

export default function SftpPanel() {
  const { servers, sftpRequest, clearSftpRequest, sftpBookmarks, addBookmark, deleteBookmark } = useAppStore();

  /**
   * The star, and the row menu's entry. `always` is the row menu, where
   * the answer is only ever "save this one", never "unsave the one I am
   * looking at".
   */
  function toggleBookmark(pane: Pane, path: string, always = false) {
    const key = bookmarkKey(pane);
    if (key === undefined) return;
    const existing = bookmarksFor(sftpBookmarks, key).find((b) => b.path === path);
    if (existing && !always) deleteBookmark(existing.id);
    else if (!existing) addBookmark({ server_id: key, label: labelFor(path, pane.style), path });
  }

  // The left pane starts on the local disk, the right on the host list. That
  // and the eager home fetch below are the only asymmetry between them.
  const left = usePane('local');
  const right = usePane('picking');

  // A path clicked in a terminal. The pane already on that host takes it,
  // else the right one connects there first. A path that is not a
  // directory shows its parent; `~` is the home directory.
  const panesRef = useRef({ left, right });
  panesRef.current = { left, right };
  useEffect(() => {
    if (!sftpRequest) return;
    const server = servers.find((s) => s.id === sftpRequest.serverId);
    if (!server) { clearSftpRequest(); return; }
    const { left, right } = panesRef.current;
    const pane = left.serverId === server.id && left.sid ? left : right;
    let cancelled = false;
    (async () => {
      const sid = await pane.connect(server);
      if (!sid || cancelled) return;
      let path = sftpRequest.path;
      if (path === '~' || path.startsWith('~/')) {
        const home = await ipc.sftpGetHome(sid).catch(() => null);
        if (!home) return;
        path = home + path.slice(1);
      }
      // A file, or a path that is not there: land in its parent instead.
      const isDir = await ipc.sftpListRemote(sid, path).then(() => true, () => false);
      const target = isDir ? path : (remoteStyle.parent(path) ?? '/');
      if (!cancelled) await pane.navigateRemote(target, sid);
    })().finally(() => { if (!cancelled) clearSftpRequest(); });
    return () => { cancelled = true; };
  // The panes are read through the ref on purpose: a request is one event.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpRequest]);

  const [dropTarget, setDropTarget] = useState<'left' | 'right' | null>(null);
  // Granted while a pane was showing local files: list them again, now that
  // they can be.
  const storage = useStorageAccess();
  useEffect(() => {
    if (!storage) return;
    for (const pane of [panesRef.current.left, panesRef.current.right]) {
      // A pane still on its way to its home folder will list it itself.
      if (pane.mode === 'local' && pane.listing.path) void pane.refresh();
    }
  }, [storage]);

  // Which pane a narrow screen shows. The right one is where a server opens.
  const [shownSide, setShownSide] = useState<'left' | 'right'>('right');
  const transfers = useTransferQueue(panesRef, () => setDropTarget(null));
  const compare = useCompare();
  useExternalDrop(setDropTarget, handleExternalDrop);

  // Mount only, and `left` cannot be named: the pane hook returns a fresh
  // object every render, so depending on it would put the pane back to its
  // local root on each one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { left.goLocal(); }, []);

  /**
   * Moves `entry` into the pane named by `target`, from the other one.
   *
   * Which of the three commands runs falls out of what the two panes are
   * showing: local to remote uploads, remote to local downloads, remote to
   * remote copies. The session ids and the destination directory are taken
   * now, when the drop happened, so a pane that navigates on while the row
   * waits its turn does not move the target.
   */
  function handleDrop(target: 'left' | 'right', batch: FileEntry[]) {
    const dst = target === 'left' ? left : right;
    const src = target === 'left' ? right : left;
    if (!canMove(src, dst)) return;
    try {
      const dstDir = dst.listing.path;
      const srcSid = src.mode === 'local' ? null : src.requireSid();
      const dstSid = dst.mode === 'local' ? null : dst.requireSid();
      const kind = transferKind(srcSid, dstSid);
      transfers.enqueueBatch(target, batch.map((entry) => ({
        name: entry.name,
        run: (id, conflict) => {
          if (kind === 'upload') return ipc.sftpUpload(id, dstSid!, entry.path, dstDir, conflict);
          if (kind === 'download') return ipc.sftpDownload(id, srcSid!, entry.path, dstDir, conflict);
          return ipc.sftpCopyRemoteToRemote(id, srcSid!, entry.path, dstSid!, dstDir, conflict);
        },
        check: () => ipc.sftpConflicts(kind, srcSid, entry.path, dstSid, dstDir),
        recopy: (id, destRoot, rels) => ipc.sftpRecopy(id, kind, srcSid, entry.path, dstSid, destRoot, rels),
      })));
    } catch (e) {
      dst.fail(String(e));
    }
  }

  /**
   * Files dragged in from the desktop, which arrive as paths rather than as
   * entries from the other pane. Only a connected remote pane can take them:
   * the local pane is the desktop, and copying a file to where it already is
   * is not a thing this does.
   */
  function handleExternalDrop(target: 'left' | 'right', paths: string[]) {
    const dst = target === 'left' ? left : right;
    if (dst.mode !== 'connected') return;
    try {
      const sid = dst.requireSid();
      const dstDir = dst.listing.path;
      transfers.enqueueBatch(target, paths.map((path) => ({
        name: localStyle().basename(path),
        run: (id, conflict) => ipc.sftpUpload(id, sid, path, dstDir, conflict),
        check: () => ipc.sftpConflicts('upload', null, path, sid, dstDir),
        recopy: (id, destRoot, rels) => ipc.sftpRecopy(id, 'upload', null, path, sid, destRoot, rels),
      })));
    } catch (e) {
      dst.fail(String(e));
    }
  }

  /**
   * One directory, tarred on the server and unpacked here. The same queue
   * row as any other transfer, so it reports, cancels and fails the same
   * way; only the work behind it differs.
   */
  function compressedCopy(target: 'left' | 'right', entry: FileEntry) {
    const dst = target === 'left' ? left : right;
    const src = target === 'left' ? right : left;
    if (!canMove(src, dst)) return;
    try {
      const dstDir = dst.listing.path;
      // The destination's listing is on screen already, so the collision
      // is known without asking the server.
      const taken = dst.listing.entries.map((e) => e.name);

      const send = (id: string, into: string | null) => {
        if (src.mode === 'local') return ipc.sftpUploadArchive(id, dst.requireSid(), entry.path, dstDir, into);
        if (dst.mode === 'local') return ipc.sftpDownloadArchive(id, src.requireSid(), entry.path, dstDir, into);
        return ipc.sftpCopyArchive(id, src.requireSid(), entry.path, dst.requireSid(), dstDir, into);
      };

      transfers.enqueueBatch(target, [{
        name: entry.name,
        run: async (id, conflict) => {
          const where = archiveTarget(taken, entry.name, conflict, freeName);
          return where.skip ? emptySummary({ skipped_existing: 1 }) : send(id, where.into);
        },
        check: async () => (taken.includes(entry.name) ? [entry.name] : []),
      }]);
    } catch (e) {
      dst.fail(String(e));
    }
  }

  /** One pane, in whichever of its five modes it is in. */
  function renderPane(pane: Pane, other: Pane, side: 'left' | 'right') {
    const browser = (
      <FileBrowser
        pathStyle={pane.style}
        title={pane.mode === 'local' ? 'Local' : pane.serverName}
        icon={pane.mode === 'local' ? LOCAL_ICON : REMOTE_ICON}
        path={pane.listing.path}
        home={pane.listing.home}
        entries={pane.listing.entries}
        loading={pane.listing.loading}
        error={pane.listing.error}
        notice={pane.notice}
        onDismissNotice={pane.dismissNotice}
        onNavigate={pane.navigate}
        onRefresh={pane.refresh}
        onNewFolder={pane.newFolder}
        canCopyToTarget={canMove(pane, other)}
        onCopyToTarget={(batch) => handleDrop(side === 'left' ? 'right' : 'left', batch)}
        onCompressedCopy={
          // Wherever an ordinary copy could go: down from a server, up to
          // one, or between two. A host without tar says so when it runs.
          canMove(pane, other)
            ? (entry) => compressedCopy(side === 'left' ? 'right' : 'left', entry)
            : undefined
        }
        onCompare={
          // Unlike a copy, two local folders are a legitimate comparison, so
          // the gate is only that both panes are showing files.
          browsing(pane) && browsing(other)
            ? (entry) => compare.compareWith(pane, other, entry)
            : undefined
        }
        onRename={pane.rename}
        onDelete={pane.removeMany}
        onSetMode={pane.setPerms}
        onMove={pane.moveInto}
        onOpen={isAndroid ? undefined : pane.open}
        onLocalBtn={() => pane.setMode('idle')}
        extraActions={closeConnectionActions(
          pane.mode === 'local' ? () => pane.setMode('idle') : pane.disconnect,
        )}
        bookmarks={bookmarksFor(sftpBookmarks, bookmarkKey(pane))}
        bookmarked={isBookmarked(sftpBookmarks, bookmarkKey(pane), pane.listing.path)}
        onToggleBookmark={pane.mode === 'connected' || pane.mode === 'local' ? () => toggleBookmark(pane, pane.listing.path) : undefined}
        onDeleteBookmark={deleteBookmark}
        onBookmarkPath={(path) => toggleBookmark(pane, path, true)}
        side={side}
        isDropTarget={dropTarget === side}
        onDragEnter={() => setDropTarget(side)}
        onDragLeave={() => setDropTarget((p) => (p === side ? null : p))}
        onFileDrop={(batch) => handleDrop(side, batch)}
        onReconnect={pane.mode === 'connected' ? pane.reconnect : undefined}
      />
    );

    switch (pane.mode) {
      case 'local':
        return storage ? browser : (
          <>
            <StorageAccessNotice what="show and transfer the files on this phone" />
            {browser}
          </>
        );
      case 'connected':
        return browser;
      case 'idle':
        return (
          <ConnectPrompt
            onSelectHost={() => pane.setMode('picking')}
            onGoLocal={pane.goLocal}
          />
        );
      case 'connecting':
        return pane.connectServer && (
          <ConnectingView
            server={pane.connectServer}
            logs={pane.connectLogs}
            error={pane.connectError || undefined}
            onClose={() => { pane.setMode('picking'); pane.setConnectError(''); }}
            onRetry={() => pane.connect(pane.connectServer!)}
            retryLabel="Retry"
          />
        );
      case 'picking':
        return (
          <HostPicker
            servers={servers}
            connectingId={pane.connectingId}
            activeServerId={pane.serverId}
            error={pane.connectError}
            onConnect={pane.connect}
            onBack={() => { pane.setMode('idle'); pane.setConnectError(''); }}
            onGoLocal={pane.goLocal}
          />
        );
    }
  }

  /** What a pane is showing, for the switch between them on a narrow screen. */
  function paneLabel(pane: Pane, fallback: string): string {
    if (pane.mode === 'local') return 'Local';
    if (pane.mode === 'connected') return pane.serverName;
    return fallback;
  }

  const { mismatches } = transfers;
  return (
    <div className="sftp-container">
      {compare.shown && (
        <CompareDialog
          left={compare.shown.left}
          right={compare.shown.right}
          diff={compare.shown.diff}
          onCancel={compare.cancel}
          onClose={compare.close}
        />
      )}

      {transfers.conflictPrompt && (
        <ConflictDialog
          prompt={transfers.conflictPrompt}
          onAnswer={transfers.answerConflict}
        />
      )}
      {mismatches && (
        <MismatchDialog
          mismatches={mismatches}
          onLeave={() => transfers.leaveMismatches(mismatches)}
          onCopyAgain={() => transfers.copyAgain(mismatches)}
        />
      )}
      {/* Narrow screens show one pane at a time; copying to the other is
          on each file's menu. */}
      <div className="sftp-pane-switch" role="tablist">
        {(['left', 'right'] as const).map((side) => (
          <button
            key={side}
            role="tab"
            aria-selected={shownSide === side}
            className={`sftp-pane-switch-btn${shownSide === side ? ' active' : ''}`}
            onClick={() => setShownSide(side)}
          >
            {side === 'left' ? paneLabel(left, 'Left') : paneLabel(right, 'Right')}
          </button>
        ))}
      </div>
      <div className="sftp-panels-row" data-shown={shownSide}>
        <div className="sftp-file-panel" data-side="left">{renderPane(left, right, 'left')}</div>
        <div className="sftp-divider" />
        <div className="sftp-file-panel sftp-remote-panel" data-side="right">{renderPane(right, left, 'right')}</div>
      </div>
      {transfers.queue.length > 0 && (
        <TransferQueue
          queue={transfers.queue}
          onCancel={transfers.cancelRow}
          onResume={transfers.resumeRow}
          onClearFinished={transfers.clearFinished}
        />
      )}
    </div>
  );
}
