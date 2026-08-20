import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Lint rules for the frontend.
 *
 * The point of this file is `react-hooks/exhaustive-deps`. TerminalView
 * already carried an `eslint-disable-next-line` for it, aimed at a linter that
 * was never installed, and three other dependency arrays claimed to depend on
 * nothing while reading values from the render around them. Those work only
 * for as long as the captured values happen to be stable, which is not a
 * property anything checks.
 *
 * Type-aware rules are deliberately left off. `tsc` already runs in the same
 * CI job and finds what they would, and turning them on would slow the lint to
 * a second type check for no new information.
 */
export default tseslint.config(
  // Everything here is either built or somebody else's: `patches` holds four
  // vendored crates whose own JavaScript is not ours to lint, and
  // `.flatpak-builder` is a copy of the whole tree including both.
  {
    ignores: [
      'dist',
      'node_modules',
      'src-tauri',
      'patches',
      '.flatpak-builder',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // `tsc` resolves every identifier against the DOM lib already, so this
      // rule only knows how to report `window` and `setTimeout` as unknown.
      'no-undef': 'off',
      // Deliberate at every site: an unused parameter named with a leading
      // underscore is documenting the signature it has to match.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
