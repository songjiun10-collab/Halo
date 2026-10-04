"use strict";

// Halo's chrome and web pages follow the OS light/dark setting (prefers-color-scheme), so a page that
// ships both themes matches the UI. Pages without a dark theme are left as they are: no forced darkening.
// It is a rendering preference only.
function applyPageTheme({ nativeTheme }) {
  if (nativeTheme) nativeTheme.themeSource = "system";
}

module.exports = { applyPageTheme };
