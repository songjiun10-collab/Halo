"use strict";

// Runtime selection happens in trusted launch configuration, before any page is loaded.
module.exports = process.env.HALO_DESKTOP_RUNTIME === "chromium"
  ? require("./harness/chromium-desktop")
  : require("electron");
