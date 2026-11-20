import { describe, expect, it } from 'vitest';
import { currentPage, isPage } from './navItems';

describe('isPage', () => {
  it('knows the pages from everything else', () => {
    expect(isPage('hosts')).toBe(true);
    expect(isPage('settings')).toBe(true);
    expect(isPage('tab-1234')).toBe(false);
    expect(isPage(null)).toBe(false);
  });

  it('agrees with currentPage', () => {
    expect(currentPage('sftp')).toBe('sftp');
    expect(currentPage('tab-1234')).toBe('hosts');
    expect(currentPage(null)).toBe('hosts');
  });
});
