"use strict";

// Runtime selection happens in trusted launch configuration, before any page is loaded.
if (process.env.HALO_DESKTOP_RUNTIME === "chromium") {
  module.exports = require("./harness/chromium-desktop");
} else {
  throw Object.assign(new Error("HALO_DESKTOP_RUNTIME must select chromium"), { code: "desktop_runtime_not_selected" });
}
