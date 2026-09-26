"use strict";

// Tests for main/harness/trusted-sender.js: the IPC sender check the design
// doc requires for the new harness channels (goal amendment, approval,
// confirmCriterion) -- "IPC sender는 해당 로컬 shell webContents의 main
// frame·로컬 UI URL과 일치해야 한다... remote WebContents에는 preload/Node/
// 이 IPC를 노출하지 않는다." A subframe of the trusted shell window (e.g. an
// embedded remote iframe) or any other window/webContents must be rejected,
// even though it shares the same Electron process. No real Electron here --
// these use plain objects shaped like Electron's IpcMainInvokeEvent/
// WebFrameMain/BrowserWindow, which is all the function ever touches.

const test = require("node:test");
const assert = require("node:assert/strict");
const { isTrustedSender } = require("../main/harness/trusted-sender");

function makeWin({ destroyed = false, mainFrameUrl = "file:///app/renderer/index.html" } = {}) {
  const mainFrame = { url: mainFrameUrl };
  return {
    isDestroyed: () => destroyed,
    webContents: { mainFrame },
    _mainFrame: mainFrame, // test-only handle to build a matching senderFrame
  };
}

test("accepts an event whose senderFrame is exactly the window's main frame at a local file:// URL", () => {
  const win = makeWin();
  const event = { senderFrame: win._mainFrame };
  assert.equal(isTrustedSender(event, win), true);
});

test("rejects an event with no senderFrame at all", () => {
  const win = makeWin();
  assert.equal(isTrustedSender({}, win), false);
  assert.equal(isTrustedSender(null, win), false);
});

test("rejects a subframe of the trusted window (e.g. an embedded remote iframe)", () => {
  const win = makeWin();
  const subframe = { url: "https://attacker.example/" };
  const event = { senderFrame: subframe };
  assert.equal(isTrustedSender(event, win), false);
});

test("rejects a frame that looks like the main frame object shape but belongs to a different window", () => {
  const win = makeWin();
  const otherWin = makeWin();
  const event = { senderFrame: otherWin._mainFrame };
  assert.equal(isTrustedSender(event, win), false);
});

test("rejects when the main frame's own URL is not a local file:// URL (defense in depth)", () => {
  const win = makeWin({ mainFrameUrl: "https://not-local.example/index.html" });
  const event = { senderFrame: win._mainFrame };
  assert.equal(isTrustedSender(event, win), false);
});

test("rejects when the window has already been destroyed", () => {
  const win = makeWin({ destroyed: true });
  const event = { senderFrame: win._mainFrame };
  assert.equal(isTrustedSender(event, win), false);
});
