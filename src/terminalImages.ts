import type { IImageAddonOptions } from '@xterm/addon-image';

/**
 * How a terminal draws Sixel and iTerm2 images, shared by session tabs and
 * the recordings player so a recording shows what the session did.
 *
 * The addon's own storage default is 128 MB per terminal; with a dozen tabs
 * open that is more than the rest of the app together, so each keeps 32 MB
 * of pixels and drops the oldest images past that.
 */
export const IMAGE_OPTIONS: IImageAddonOptions = {
  sixelSupport: true,
  iipSupport: true,
  storageLimit: 32,
  // Answers the size queries img2sixel and chafa send to pick a resolution.
  enableSizeReports: true,
};
