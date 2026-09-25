import { useState } from 'react';
import * as ipc from './ipc';
import { terminalFor } from './terminalRegistry';
import { transcriptLines, transcriptName, transcriptText } from './transcript';
import type { SessionTab } from './types';
import { tabLabel } from './tabName';

/** A transcript waiting for a path to be written to. */
export interface PendingSave {
  /**
   * Taken when the menu entry was pressed, so what lands is what was on
   * screen then rather than whatever has arrived by the time the picker is
   * answered.
   */
  text: string;
  startDir: string;
  name: string;
}

/**
 * Taking a tab's scrollback out of the app, to the clipboard or to a file.
 *
 * Session logging writes from connect time onward and has to be turned on
 * before there is anything to log; this is whatever is on screen now, which
 * is the case where something has already happened and is worth keeping.
 *
 * The reading and the naming are in `transcript`, which has the tests; what
 * is here is the part that talks to a terminal, a clipboard and a file.
 */
export function useTranscript(onError: (message: string) => void) {
  const [saving, setSaving] = useState<PendingSave | null>(null);

  function textOf(session: SessionTab): string | null {
    const term = terminalFor(session.tab_id);
    if (!term) return null;
    const text = transcriptText(transcriptLines(term.buffer.active));
    if (text === '') {
      onError(`Nothing has been printed in "${tabLabel(session)}" yet`);
      return null;
    }
    return text;
  }

  async function copy(session: SessionTab) {
    const text = textOf(session);
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      onError(`Could not copy the transcript: ${e}`);
    }
  }

  /** Opens the picker where an export would, named for the host and the time. */
  async function save(session: SessionTab) {
    const text = textOf(session);
    if (text === null) return;
    let startDir = '';
    try {
      startDir = await ipc.defaultExportDir();
    } catch {
      // No Downloads to find: the picker falls back to the home directory.
    }
    setSaving({ text, startDir, name: transcriptName(session.server_name, new Date()) });
  }

  /**
   * Writes it, and asks before replacing a file that is already there. The
   * refusal comes from the open rather than from a check of our own, so
   * nothing can appear at that path in between.
   */
  async function write(path: string, text: string, overwrite = false) {
    try {
      await ipc.writeTextFile(path, text, overwrite);
      setSaving(null);
    } catch (e) {
      const message = String(e);
      if (!overwrite && message.includes('already exists')) {
        if (window.confirm(`${path} already exists. Save anyway?`)) {
          await write(path, text, true);
        }
        return;
      }
      setSaving(null);
      onError(message);
    }
  }

  return { saving, copy, save, write, cancelSave: () => setSaving(null) };
}
