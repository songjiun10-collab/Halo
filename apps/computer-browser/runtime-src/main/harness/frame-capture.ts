"use strict";

interface CaptureOptions { maxWidth: number; quality: number }
interface Page {
  isDestroyed?(): boolean;
  getURL?(): string;
  captureJpeg?(options: CaptureOptions): Promise<Buffer>;
  capturePage(): Promise<any>;
}
const pending = new WeakMap<Page, Map<string, Promise<Buffer | null>>>();
const MAX_BYTES = 8 * 1024 * 1024;

// Merge only concurrent captures with identical dimensions/quality, never cache
// an old observation. Ownership and current-view identity remain caller checks.
function captureFrameJpeg(page: Page, options: CaptureOptions): Promise<Buffer | null> {
  const { maxWidth, quality } = options;
  if (!Number.isInteger(maxWidth) || maxWidth < 1 || maxWidth > 8192 || !Number.isInteger(quality) || quality < 1 || quality > 100) return Promise.reject(new Error("invalid_capture_options"));
  if (page.isDestroyed?.()) return Promise.resolve(null);
  let entries = pending.get(page);
  if (!entries) { entries = new Map(); pending.set(page, entries); }
  const key = `${maxWidth}:${quality}`;
  const prior = entries.get(key);
  if (prior) return prior;
  const url = page.getURL?.();
  const capture = (async () => {
    let jpeg: Buffer;
    if (typeof page.captureJpeg === "function") jpeg = await page.captureJpeg(options);
    else {
      let image = await page.capturePage();
      if (!image || image.isEmpty()) return null;
      if (image.getSize().width > maxWidth) image = image.resize({ width: maxWidth, quality: "good" });
      jpeg = typeof image.encodeJpegAsync === "function" ? await image.encodeJpegAsync(quality) : image.toJPEG(quality);
    }
    if (page.isDestroyed?.() || page.getURL?.() !== url || !Buffer.isBuffer(jpeg) || !jpeg.length || jpeg.length > MAX_BYTES) return null;
    return jpeg;
  })();
  entries.set(key, capture);
  const clear = () => { if (entries!.get(key) === capture) entries!.delete(key); };
  void capture.then(clear, clear);
  return capture;
}
export = { captureFrameJpeg };
