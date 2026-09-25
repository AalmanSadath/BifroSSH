import { describe, expect, it } from 'vitest';
import { cleanTitle, tabLabel } from './tabName';

describe('tabLabel', () => {
  it('is the host name until the tab has one of its own', () => {
    expect(tabLabel({ server_name: 'gateway', title: undefined })).toBe('gateway');
    expect(tabLabel({ server_name: 'gateway (1)', title: 'logs' })).toBe('logs');
  });
});

describe('cleanTitle', () => {
  it('keeps a name the user typed', () => {
    expect(cleanTitle('  logs  ', 'gateway')).toBe('logs');
  });

  it('reads blank as no name of its own', () => {
    expect(cleanTitle('', 'gateway')).toBeUndefined();
    expect(cleanTitle('   ', 'gateway')).toBeUndefined();
  });

  it('reads the host name back as undoing the rename', () => {
    expect(cleanTitle('gateway', 'gateway')).toBeUndefined();
  });
});
