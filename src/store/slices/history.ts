import * as ipc from '../../ipc';
import { remember } from '../../commandHistory';
import { dropQueuedCommands, queueCommand } from '../persistence';
import type { Slice } from '../types';

export interface HistorySlice {
  /**
   * Commands run at a prompt, by server id, most recent first, for the
   * terminal's suggestions. Loaded per host the first time it is connected.
   */
  commandHistory: Record<string, string[]>;
  loadCommandHistory: (serverId: string) => Promise<void>;
  learnCommand: (serverId: string, command: string) => void;
  clearCommandHistory: (serverId: string | null) => Promise<void>;
}

export const createHistorySlice: Slice<HistorySlice> = (set, get) => ({
  commandHistory: {},
  loadCommandHistory: async (serverId) => {
    if (!serverId || get().commandHistory[serverId]) return;
    try {
      const saved = await ipc.getCommandHistory(serverId);
      // Anything learned while the read was in flight goes in front of it.
      set((s) => {
        const learned = s.commandHistory[serverId] ?? [];
        const merged = learned.reduceRight((list, c) => remember(list, c), saved);
        return { commandHistory: { ...s.commandHistory, [serverId]: merged } };
      });
    } catch {
      // No suggestions until the next connect; nothing else depends on it.
    }
  },
  learnCommand: (serverId, command) => {
    if (!serverId) return;
    set((s) => ({
      commandHistory: {
        ...s.commandHistory,
        [serverId]: remember(s.commandHistory[serverId] ?? [], command),
      },
    }));
    queueCommand(serverId, command);
  },
  clearCommandHistory: async (serverId) => {
    dropQueuedCommands(serverId);
    await ipc.clearCommandHistory(serverId);
    set((s) => {
      if (serverId === null) return { commandHistory: {} };
      const next = { ...s.commandHistory };
      next[serverId] = [];
      return { commandHistory: next };
    });
  },
});
