const { HEADER_HEIGHT, FOOTER_HEIGHT, SIDE_PANEL_WIDTH, MOBILE_BREAKPOINT } = require("./layout-constants");

// Never trust renderer-supplied bounds directly: a compromised or malicious
// renderer could otherwise position the native WebContentsView overlay on
// top of the approval queue / timeline chrome, tricking a reviewer into
// approving something while the real page is masked. This clamp is the only
// thing standing between an arbitrary {x,y,width,height} and the window.
function clampBrowserBounds(bounds, contentWidth, contentHeight) {
  if (
    typeof bounds !== "object" || bounds === null ||
    !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) ||
    !Number.isFinite(contentWidth) || !Number.isFinite(contentHeight) ||
    contentWidth < 0 || contentHeight < 0
  ) {
    throw new TypeError("clampBrowserBounds requires finite numeric bounds and content size");
  }

  const isDesktop = contentWidth > MOBILE_BREAKPOINT;
  const maxRight = Math.max(0, isDesktop ? contentWidth - SIDE_PANEL_WIDTH : contentWidth);
  const minY = HEADER_HEIGHT;
  const maxBottom = Math.max(minY, contentHeight - FOOTER_HEIGHT);

  const x = Math.max(0, Math.min(bounds.x, maxRight));
  const y = Math.max(minY, Math.min(bounds.y, maxBottom));
  const width = Math.max(0, Math.min(bounds.width, maxRight - x));
  const height = Math.max(0, Math.min(bounds.height, maxBottom - y));

  return {
    x: Math.round(x), y: Math.round(y),
    width: Math.round(width), height: Math.round(height),
  };
}

module.exports = { clampBrowserBounds };
