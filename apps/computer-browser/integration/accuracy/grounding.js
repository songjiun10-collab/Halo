"use strict";

// The hallucination detector was promoted to main/harness/grounding.js so the
// runtime device (task-controller) and this benchmark harness share exactly one
// implementation. This file stays as the harness's import path.
module.exports = require("../../main/harness/grounding");
