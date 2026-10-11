"use strict";

// The builtin playbooks carry the hallucination-prevention rule alongside the
// runtime device: specific values come from pages actually read, gaps are never
// filled with plausible values. These assertions pin the text so a rewrite that
// drops the discipline fails here instead of silently shipping.

const test = require("node:test");
const assert = require("node:assert/strict");
const { selectBuiltinPlaybooks, MAX_PLAYBOOK_BYTES } = require("../main/harness/skill-library");

test("research requests carry the grounded-answer discipline", () => {
  const packet = selectBuiltinPlaybooks({ originalRequest: "최신 노트북 가격을 비교 조사해줘" });
  assert.ok(packet);
  const research = packet.items.find((item) => item.id === "source-grounded-research");
  assert.ok(research, "the research playbook is selected");
  assert.match(research.instructions, /Copy every specific value from a page you actually read/);
  assert.match(research.instructions, /never infer or fill in a model code, quantity, price or date from memory/);
});

test("extraction requests forbid filling gaps", () => {
  const packet = selectBuiltinPlaybooks({ originalRequest: "표로 전체 항목 추출해서 목록 정리해줘" });
  assert.ok(packet);
  const extraction = packet.items.find((item) => item.id === "bounded-data-extraction");
  assert.ok(extraction, "the extraction playbook is selected");
  assert.match(extraction.instructions, /never fill a gap with a plausible value/);
});

test("the builtin packet stays within its byte budget", () => {
  const packet = selectBuiltinPlaybooks({ originalRequest: "research the latest benchmarks and compare sources" });
  assert.ok(packet);
  assert.ok(Buffer.byteLength(JSON.stringify(packet), "utf8") <= MAX_PLAYBOOK_BYTES);
  assert.ok(packet.items.length <= 2);
});

test("the grounding discipline can be switched off for an A/B run", () => {
  const { spawnSync } = require("node:child_process");
  const library = require.resolve("../main/harness/skill-library");
  const script = "const { selectBuiltinPlaybooks } = require(process.argv[1]); const packet = selectBuiltinPlaybooks({ originalRequest: \"최신 노트북 가격을 비교 조사해줘\" }); const research = packet.items.find((item) => item.id === \"source-grounded-research\"); process.stdout.write(research.instructions);";
  const on = spawnSync(process.execPath, ["-e", script, library], { encoding: "utf8" });
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /Copy every specific value/);
  const off = spawnSync(process.execPath, ["-e", script, library], { encoding: "utf8", env: { ...process.env, HALO_GROUNDING_GUIDE_OFF: "1" } });
  assert.equal(off.status, 0, off.stderr);
  assert.doesNotMatch(off.stdout, /Copy every specific value/);
});
