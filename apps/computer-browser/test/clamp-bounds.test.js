"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { clampBrowserBounds } = require("../shared/clamp-bounds");
const { HEADER_HEIGHT, FOOTER_HEIGHT, SIDE_PANEL_WIDTH, MOBILE_BREAKPOINT } = require("../shared/layout-constants");

test("desktop: reserves the right side panel width", () => {
  const result = clampBrowserBounds({ x: 0, y: 124, width: 937, height: 571 }, 1280, 720);
  assert.equal(result.x, 0);
  assert.equal(result.y, HEADER_HEIGHT);
  assert.ok(result.x + result.width <= 1280 - SIDE_PANEL_WIDTH);
  assert.ok(result.y + result.height <= 720 - FOOTER_HEIGHT);
});

test("desktop: a bounds request that tries to invade the side panel is clamped", () => {
  const result = clampBrowserBounds({ x: 0, y: 124, width: 1280, height: 571 }, 1280, 720);
  assert.equal(result.x + result.width, 1280 - SIDE_PANEL_WIDTH);
});

test("desktop: a bounds request that tries to invade the header/footer is clamped", () => {
  const result = clampBrowserBounds({ x: 0, y: 0, width: 900, height: 720 }, 1280, 720);
  assert.equal(result.y, HEADER_HEIGHT);
  assert.equal(result.y + result.height, 720 - FOOTER_HEIGHT);
});

test("mobile: no side panel inset below the breakpoint", () => {
  const result = clampBrowserBounds({ x: 0, y: 124, width: 680, height: 300 }, 600, 900);
  assert.equal(result.x + result.width, 600);
});

test("mobile: header/footer insets still apply at the breakpoint boundary", () => {
  const result = clampBrowserBounds({ x: 0, y: 0, width: 600, height: 900 }, MOBILE_BREAKPOINT, 900);
  assert.equal(result.y, HEADER_HEIGHT);
  assert.equal(result.y + result.height, 900 - FOOTER_HEIGHT);
});

test("rejects negative coordinates by clamping to zero, never negative", () => {
  const result = clampBrowserBounds({ x: -50, y: -50, width: 100, height: 100 }, 1280, 720);
  assert.equal(result.x, 0);
  assert.ok(result.y >= HEADER_HEIGHT);
});

test("rejects non-finite input rather than silently coercing it", () => {
  assert.throws(() => clampBrowserBounds({ x: NaN, y: 0, width: 10, height: 10 }, 1280, 720), TypeError);
  assert.throws(() => clampBrowserBounds({ x: 0, y: 0, width: 10, height: 10 }, Infinity, 720), TypeError);
  assert.throws(() => clampBrowserBounds(null, 1280, 720), TypeError);
});

test("a tiny content window never produces negative width/height", () => {
  const result = clampBrowserBounds({ x: 0, y: 0, width: 500, height: 500 }, 50, 50);
  assert.ok(result.width >= 0);
  assert.ok(result.height >= 0);
});
