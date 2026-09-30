// Single source of truth for the renderer/main layout boundary. preload
// exposes these (camelCased) as window.haloBrowser.layout; renderer.js
// injects them as CSS custom properties so the CSS and the bounds-clamping
// logic in main/control-api.js can never drift apart.
module.exports = Object.freeze({
  HEADER_HEIGHT: 124,
  FOOTER_HEIGHT: 25,
  SIDE_PANEL_WIDTH: 342,
  MOBILE_BREAKPOINT: 680,
});
