import { describe, expect, it } from 'vitest';
import { canExport } from './ExportDataModal';

const base = {
  path: 'C:\\Users\\me\\Downloads\\bifrossh-export.bfx',
  passphrase: 'correct horse battery staple',
  confirmPass: 'correct horse battery staple',
  generated: false,
  saved: false,
  busy: false,
};

describe('canExport', () => {
  it('wants a destination, a passphrase, and not to be mid-export', () => {
    expect(canExport(base)).toBe(true);
    expect(canExport({ ...base, path: '' })).toBe(false);
    expect(canExport({ ...base, passphrase: '', confirmPass: '' })).toBe(false);
    expect(canExport({ ...base, busy: true })).toBe(false);
  });

  it('makes a typed passphrase match its confirmation', () => {
    expect(canExport({ ...base, confirmPass: 'something else' })).toBe(false);
    expect(canExport({ ...base, confirmPass: '' })).toBe(false);
  });

  /**
   * The bug this exists for. The confirm field is only rendered for a typed
   * passphrase, so demanding a match from a generated one left the export
   * button greyed for ever, with no message explaining it.
   */
  it('asks a generated passphrase to be saved, not confirmed', () => {
    const gen = { ...base, generated: true, confirmPass: '' };
    expect(canExport({ ...gen, saved: false })).toBe(false);
    expect(canExport({ ...gen, saved: true })).toBe(true);
  });

  /** Ticking "saved" is not a way round confirming one you typed. */
  it('does not let saved stand in for a confirmation', () => {
    expect(canExport({ ...base, saved: true, confirmPass: 'wrong' })).toBe(false);
  });
});
