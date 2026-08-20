import { describe, expect, it } from 'vitest';
import { describeCounts } from './types';
import type { TransferCounts } from './types';

function counts(over: Partial<TransferCounts> = {}): TransferCounts {
  return {
    servers: 0,
    identities: 0,
    keys: 0,
    port_forwardings: 0,
    codeprints: 0,
    custom_themes: 0,
    known_hosts: 0,
    ...over,
  };
}

describe('describeCounts', () => {
  it('leaves out what did not happen', () => {
    expect(describeCounts(counts({ servers: 3 }))).toBe('3 hosts');
    expect(describeCounts(counts())).toBe('nothing');
  });

  it('pluralises each clause on its own count', () => {
    expect(describeCounts(counts({ servers: 1, identities: 2 })))
      .toBe('1 host and 2 identities');
  });

  it('joins with commas and a final "and"', () => {
    expect(describeCounts(counts({ servers: 3, keys: 1, known_hosts: 2 })))
      .toBe('3 hosts, 1 key and 2 known hosts');
  });

  /**
   * The reason this function exists. The export modal hand-wrote all seven
   * clauses into one sentence, so an eighth collection added on the Rust side
   * would have gone unmentioned in the summary of what was written to the
   * file. This fails if a field is added to TransferCounts without a name.
   */
  it('has a name for every collection it counts', () => {
    const all = counts({
      servers: 1, identities: 1, keys: 1, port_forwardings: 1,
      codeprints: 1, custom_themes: 1, known_hosts: 1,
    });
    // One clause per field, or a field went unmentioned. Counting them is the
    // check: the names themselves live in COUNT_NAMES, and a field added to
    // TransferCounts without an entry there produces one clause too few.
    const clauses = describeCounts(all).split(/, | and /);
    expect(clauses).toHaveLength(Object.keys(all).length);
  });
});
