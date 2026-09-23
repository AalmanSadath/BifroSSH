import PortalDropdown from '../shared/PortalDropdown';
import { useAppStore, reportFailure } from '../../store/appStore';
import type { Settings } from '../../types';

export interface PickerOption<T extends string> {
  value: T;
  label: string;
}

/**
 * One dropdown, shared by the cursor style, font family and auto-lock fields.
 *
 * `previewFont` renders each option in the family it names, which is the whole
 * point of a font list: the names mean little until you can see them.
 */
export function Picker<T extends string>({
  value,
  options,
  onChange,
  previewFont = false,
}: {
  value: T;
  options: PickerOption<T>[];
  onChange: (v: T) => void;
  previewFont?: boolean;
}) {
  const label = options.find((o) => o.value === value)?.label ?? value;

  return (
    <PortalDropdown label={label} maxHeight={280}>
      {(close) => options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`picker-item${previewFont ? ' picker-item-font' : ''}${value === o.value ? ' selected' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onChange(o.value); close(); }}
        >
          {previewFont ? (
            <>
              <span>{o.label}</span>
              <span className="picker-font-sample" style={{ fontFamily: o.value }}>AaBb0123</span>
            </>
          ) : o.label}
        </button>
      ))}
    </PortalDropdown>
  );
}

/**
 * Writes a few fields of the settings, leaving the rest as they are.
 *
 * Every section wants this and each had its own copy of the spread; one
 * mistake in one of them would have saved a stale document over a fresh one.
 */
export function usePatch(): (p: Partial<Settings>) => void {
  const { settings, saveSettings } = useAppStore();
  return (p) => { saveSettings({ ...settings, ...p }).catch(reportFailure); };
}
