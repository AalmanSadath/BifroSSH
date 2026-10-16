import type { StateCreator } from 'zustand';
import type { AppSlice } from './slices/app';
import type { BootstrapSlice } from './slices/bootstrap';
import type { ConnectSlice } from './slices/connect';
import type { HistorySlice } from './slices/history';
import type { LibrarySlice } from './slices/library';
import type { ProbesSlice } from './slices/probes';
import type { ReconnectSlice } from './slices/reconnect';
import type { RecordsSlice } from './slices/records';
import type { SessionsSlice } from './slices/sessions';
import type { SettingsSlice } from './slices/settings';
import type { SplitsSlice } from './slices/splits';
import type { TunnelsSlice } from './slices/tunnels';

/**
 * The whole store, as one flat object.
 *
 * Written as slices so no one file holds all of it, but still a single store:
 * components read fields from any slice off one `useAppStore()`, and an action
 * reaches any other slice's state through `get()`, as the ones that cascade
 * (a delete, a tab closing, a lock) have to.
 */
export type AppStore =
  & AppSlice
  & BootstrapSlice
  & ConnectSlice
  & HistorySlice
  & LibrarySlice
  & ProbesSlice
  & ReconnectSlice
  & RecordsSlice
  & SessionsSlice
  & SettingsSlice
  & SplitsSlice
  & TunnelsSlice;

/** One slice's part of the store, given `set` and `get` over all of it. */
export type Slice<T> = StateCreator<AppStore, [], [], T>;
