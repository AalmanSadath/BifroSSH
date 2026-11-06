/**
 * The shortest passphrase a user may choose, matching MIN_PASSPHRASE_CHARS in
 * keystore.rs, which refuses anything shorter whatever the page lets through.
 */
export const MIN_PASSPHRASE_CHARS = 12;

/**
 * Whether a passphrase is long enough to offer. A generated one always is:
 * it is eight words. Counted in characters, as the backend counts them, not
 * UTF-16 units.
 */
export function longEnough(passphrase: string, generated = false): boolean {
  return generated || [...passphrase].length >= MIN_PASSPHRASE_CHARS;
}

/** What to show under a typed passphrase that is not long enough yet. */
export const TOO_SHORT = `At least ${MIN_PASSPHRASE_CHARS} characters.`;
