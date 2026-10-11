"use strict";

// Web Bot Auth signs the agent's traffic only. A user tab (partition
// "halo-direct") must never carry the agent signature.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const pageModule = require("../main/harness/cdp-web-contents");
const { CdpEngine } = require("../main/harness/cdp-engine");

test("request signing skips the user partition and covers agent partitions", (t) => {
  const captured = new Map();
  const original = pageModule.createCdpView;
  pageModule.createCdpView = (provider, options) => {
    const webContents = new EventEmitter();
    webContents.isDestroyed = () => false;
    captured.set(captured.size, options);
    return { webContents };
  };
  t.after(() => { pageModule.createCdpView = original; });

  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium" });
  engine.setRequestSigner((url) => ({ signature: `sig:${url}` }));

  engine.createPage("halo-direct");
  engine.createPage("persist:halo-agent-123e4567-e89b-12d3-a456-426614174000");
  engine.createPage("halo-task-x");

  const [user, profile, task] = [0, 1, 2].map((i) => captured.get(i).signRequestHeaders("https://a.test/"));
  assert.equal(user, null);
  assert.deepEqual(profile, { signature: "sig:https://a.test/" });
  assert.deepEqual(task, { signature: "sig:https://a.test/" });

  // User tabs render at the screen's 2x density; agent pages stay at 1x.
  assert.equal(captured.get(0).deviceScaleFactor, 2);
  assert.equal(captured.get(1).deviceScaleFactor, 1);
  assert.equal(captured.get(2).deviceScaleFactor, 1);

  engine.setRequestSigner(null);
  assert.equal(captured.get(1).signRequestHeaders("https://a.test/"), null);
});
