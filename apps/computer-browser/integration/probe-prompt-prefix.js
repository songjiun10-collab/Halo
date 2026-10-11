"use strict";

// TEMPORARY measurement probe. Measures the planner prompt HALO itself builds:
// the fixed prefix (identical for every task and turn -- the deliberate
// prompt-cache prefix) versus the per-turn context JSON, and how both move for
// the same task across turns.
//
//   node integration/probe-prompt-prefix.js
//
// This measures HALO's prompt text only. The CLI's own base system prompt and
// tool schemas are added by the provider and are not visible here.

const { buildPrompt } = require("../main/harness/providers/claude-code-bridge");

const GUIDANCE = "x".repeat(2000); // stand-in so the pinned-guidance slice is visible

function makeContext(turn, { elements = 40, textLines = 60, errorUrls = 0, history = 0 } = {}) {
  return {
    schemaVersion: 1,
    taskId: "11111111-1111-4111-8111-111111111111",
    goalVersion: 1,
    goal: {
      originalRequest: "Compare the two cheapest fares on the page and report which is cheaper.",
      criteria: [{ id: "c1", text: "compare the fares", required: true, verification: "host" }],
    },
    observation: {
      id: `obs-${turn}`, documentEpoch: 1, url: "http://127.0.0.1:8081/", title: "Probe page",
      text: Array.from({ length: textLines }, (_, i) => `Item ${i}: paragraph body with readable content.`).join("\n"),
      elements: Array.from({ length: elements }, (_, i) => ({
        elementId: String(i), parentElementId: null, role: i % 3 === 0 ? "link" : "button",
        name: `Item ${i} action`, text: `Item ${i}`,
      })),
    },
    progress: {
      criteriaStatus: { c1: false },
      budgets: { plannerCallsUsed: turn, actionsUsed: turn, maxPlannerCalls: 25 },
      ...(errorUrls > 0 ? { errorUrls: Array.from({ length: errorUrls }, (_, i) => `https://broken.example/${i}`) } : {}),
    },
    navigationHistory: {
      visited: Array.from({ length: history }, (_, i) => `https://example.test/page/${i}`),
      frontier: [],
    },
  };
}

function report(label, bytes) {
  console.log(`${label.padEnd(34)} ${String(bytes).padStart(8)} bytes   ~${String(Math.round(bytes / 4)).padStart(6)} tok est`);
}

function main() {
  const turn1 = buildPrompt(makeContext(1), null);
  const turn2 = buildPrompt(makeContext(2), null);
  const turn20 = buildPrompt(makeContext(20), null);

  // The per-turn context JSON is everything from the "Context (JSON):" line on.
  const contextOf = (prompt) => prompt.slice(prompt.lastIndexOf("Context (JSON):\n") + "Context (JSON):\n".length);
  const prefixOf = (prompt) => prompt.slice(0, prompt.lastIndexOf("Context (JSON):\n"));

  const buf = (s) => Buffer.byteLength(s, "utf8");

  console.log("HALO PROMPT TEXT (provider adds its own system prompt and tool schemas)\n");
  report("turn 1 prompt total", buf(turn1));
  report("  fixed prefix (cacheable)", buf(prefixOf(turn1)));
  report("  per-turn context JSON", buf(contextOf(turn1)));
  console.log("");
  report("turn 20 prompt total", buf(turn20));
  report("  fixed prefix (cacheable)", buf(prefixOf(turn20)));
  report("  per-turn context JSON", buf(contextOf(turn20)));

  console.log(`\nfixed prefix is ${((buf(prefixOf(turn1)) / buf(turn1)) * 100).toFixed(0)}% of the prompt on turn 1`);
  console.log(`prefix identical across turns: ${prefixOf(turn1) === prefixOf(turn20)}`);

  // What makes the per-turn part grow.
  console.log("\nper-turn context JSON sensitivity (bytes):");
  const cases = {
    "baseline (40 elements, 60 text lines)": makeContext(1),
    "10 elements, 10 text lines": makeContext(1, { elements: 10, textLines: 10 }),
    "80 elements, 120 text lines": makeContext(1, { elements: 80, textLines: 120 }),
    "baseline + 10 errorUrls": makeContext(1, { errorUrls: 10 }),
    "baseline + 30 visited pages": makeContext(1, { history: 30 }),
  };
  const base = buf(contextOf(buildPrompt(cases["baseline (40 elements, 60 text lines)"], null)));
  for (const [label, ctx] of Object.entries(cases)) {
    const v = buf(contextOf(buildPrompt(ctx, null)));
    console.log(`  ${label.padEnd(40)} ${String(v).padStart(7)}  ${v >= base ? "+" : ""}${v - base}`);
  }

  console.log("\nwith pinned model guidance (advisory):");
  const withGuidance = buildPrompt(makeContext(1), GUIDANCE);
  report("  prompt total", buf(withGuidance));
  console.log(`  guidance slice adds ${buf(withGuidance) - buf(turn1)} bytes (placeholder is ${GUIDANCE.length})`);

  console.log("\nBytes only. Tokens are provider-reported; tok est assumes 4 chars/token.");
}

main();