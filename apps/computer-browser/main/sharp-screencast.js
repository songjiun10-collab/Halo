"use strict";

// A CDP screencast frame is always viewport-sized in CSS pixels, so it is never
// sharper than 1x. When the page can capture stills, the screencast only signals
// "something painted" (small, cheap frames) and the frame handed on is a still
// captured on that signal, at the density the caller asks for. A page that cannot
// capture stills keeps the plain screencast frames.

const SIGNAL = Object.freeze({ maxWidth: 640, quality: 30 });

// onFrame(base64Jpeg) gets only the newest picture; at most one still is in
// flight and paints that land meanwhile ask for exactly one more.
async function startSharpScreencast(page, { stillWidth, stillQuality, density = 1, plain }, onFrame) {
  const sharp = typeof page.captureJpeg === "function";
  let open = true;
  let capturing = false;
  let again = false;
  const capture = async (fallback) => {
    if (capturing) { again = true; return; }
    capturing = true;
    try {
      const still = await page.captureJpeg({ maxWidth: stillWidth, quality: stillQuality, density });
      if (open) onFrame(Buffer.from(still).toString("base64"));
    } catch {
      if (open) onFrame(fallback);
    } finally {
      capturing = false;
      if (again && open) { again = false; void capture(fallback); }
    }
  };
  await page.startScreencast(sharp ? SIGNAL : plain, (data) => {
    if (!open) return;
    if (sharp) void capture(data); else onFrame(data);
  });
  return async () => {
    open = false;
    await page.stopScreencast?.().catch(() => undefined);
  };
}

module.exports = { startSharpScreencast };
