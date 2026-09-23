import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, clampZoom, zoomPercent } from './zoom';

describe('clampZoom', () => {
  it('holds the size inside the range the setting allows', () => {
    expect(clampZoom(14)).toBe(14);
    expect(clampZoom(MIN_ZOOM - 4)).toBe(MIN_ZOOM);
    expect(clampZoom(MAX_ZOOM + 10)).toBe(MAX_ZOOM);
  });

  it('rounds, since a font size is whole points here', () => {
    expect(clampZoom(14.4)).toBe(14);
    expect(clampZoom(14.6)).toBe(15);
  });
});

describe('zoomPercent', () => {
  it('says nothing for a tab at the size everything else uses', () => {
    expect(zoomPercent(undefined, 14)).toBeNull();
    expect(zoomPercent(14, 14)).toBeNull();
  });

  it('reads as a percentage of that size', () => {
    expect(zoomPercent(28, 14)).toBe(200);
    expect(zoomPercent(7, 14)).toBe(50);
    expect(zoomPercent(17, 14)).toBe(121);
  });
});
