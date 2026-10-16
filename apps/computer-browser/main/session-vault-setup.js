"use strict";

// Chromium runtime only: persist agent cookies across restarts in an encrypted vault.
// Any failure falls back to running without a vault; it must never block startup.
function attachSessionVault({ app, safeStorage, cdpEngine, isChromium, createSessionVault, path }) {
  if (!isChromium || !cdpEngine || typeof cdpEngine.setSessionVault !== "function") return null;
  try {
    const vault = createSessionVault({ dir: path.join(app.getPath("userData"), "agent-sessions"), storage: safeStorage });
    cdpEngine.setSessionVault(vault);
    return vault;
  } catch {
    return null;
  }
}

module.exports = { attachSessionVault };
