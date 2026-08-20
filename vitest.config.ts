import { defineConfig } from 'vitest/config';

/**
 * Separate from vite.config.ts on purpose.
 *
 * That file is written for `tauri dev`: a fixed port, a watcher told to ignore
 * the Rust tree, and an async factory reading TAURI_DEV_HOST. None of it
 * applies to a test run, and inheriting it would mean a test suite that fails
 * because port 1420 is busy.
 */
export default defineConfig({
  test: {
    // The store reads localStorage at module load to recover the cached theme
    // before the vault is open, so there has to be a document.
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
