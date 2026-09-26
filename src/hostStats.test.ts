import { describe, expect, it } from 'vitest';
import { monitorWanted } from './hostStats';

describe('monitorWanted', () => {
  it('follows the setting for a host left on Default, and for a quick connection', () => {
    expect(monitorWanted(true, { monitor: null })).toBe(true);
    expect(monitorWanted(false, { monitor: undefined })).toBe(false);
    expect(monitorWanted(true, undefined)).toBe(true);
  });

  it('lets a host say Always or Never whatever the setting is', () => {
    expect(monitorWanted(false, { monitor: true })).toBe(true);
    expect(monitorWanted(true, { monitor: false })).toBe(false);
  });
});
