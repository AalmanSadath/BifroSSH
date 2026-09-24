import { useAppStore } from '../../store/appStore';

/**
 * A tooltip, or nothing where the user has turned tooltips off.
 *
 * Written out in eight components, each subscribing to the whole settings
 * object to read one boolean. `title={hint('...')}` reads the same as
 * `title="..."` at the call site, which is what makes it easy to write the
 * line again rather than reach for it.
 */
export function useHint(): (text: string) => string | undefined {
  const show = useAppStore((s) => s.settings.show_hover_hints);
  return (text: string) => (show ? text : undefined);
}
