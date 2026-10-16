"use strict";

// Node host + Chromium desktop. The same entry point works for the LaunchAgent service.
process.env.HALO_DESKTOP_RUNTIME = "chromium";
require("../main/index");
