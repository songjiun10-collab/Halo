const { HEADER_HEIGHT, FOOTER_HEIGHT, SIDE_PANEL_WIDTH, MOBILE_BREAKPOINT } = require("./layout-constants") as typeof import("./layout-constants");

type BrowserBounds = { x: number; y: number; width: number; height: number };

// Renderer input remains unknown: runtime validation must precede arithmetic.
function clampBrowserBounds(bounds: unknown, contentWidth: number, contentHeight: number): BrowserBounds {
  const candidate = bounds as BrowserBounds;
  if (
    typeof bounds !== "object" || bounds === null ||
    !Number.isFinite(candidate.x) || !Number.isFinite(candidate.y) ||
    !Number.isFinite(candidate.width) || !Number.isFinite(candidate.height) ||
    !Number.isFinite(contentWidth) || !Number.isFinite(contentHeight) ||
    contentWidth < 0 || contentHeight < 0
  ) {
    throw new TypeError("clampBrowserBounds requires finite numeric bounds and content size");
  }

  const isDesktop = contentWidth > MOBILE_BREAKPOINT;
  const maxRight = Math.max(0, isDesktop ? contentWidth - SIDE_PANEL_WIDTH : contentWidth);
  const minY = HEADER_HEIGHT;
  const maxBottom = Math.max(minY, contentHeight - FOOTER_HEIGHT);
  const x = Math.max(0, Math.min(candidate.x, maxRight));
  const y = Math.max(minY, Math.min(candidate.y, maxBottom));
  const width = Math.max(0, Math.min(candidate.width, maxRight - x));
  const height = Math.max(0, Math.min(candidate.height, maxBottom - y));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

export = { clampBrowserBounds };
