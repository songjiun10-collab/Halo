"use strict";

// A second, still fully deterministic, still NOT natural-language JSONL
// stdio Planner worker for the real-Electron long-horizon integration test
// (integration/long-horizon-electron.js) -- fixtures/scripted-planner.js
// (Task 3) proposes a single fixed "observe" and is deliberately too dumb to
// drive a real multi-page journey; this one adds exactly enough pattern
// matching to walk fixtures/long-horizon-site.js's 3-page chain, still with
// zero language understanding:
//   - if the observation's text or accessible element names contain the
//     fixture's literal completion marker "DONE-XYZ", propose "finish"
//   - else if the compact observation has a link whose accessible name matches
//     /next/i, propose follow_link against that element's host-assigned id
//   - else if nothing has been navigated yet (about:blank/empty url),
//     extract a bare https?://... URL out of the goal's own originalRequest
//     text and propose navigating to exactly that string
//   - else, propose a plain re-observe (should not normally trigger against
//     this fixture)
// This is regex/string matching over a KNOWN fixture's fixed HTML, not a
// general capability -- it is not evidence of, and never presented as,
// natural-language planning quality (design doc section 6: "프로토콜
// fixture는 자연어 모델 품질의 증거가 아니다").
//
// Lives outside test/ for the same node --test file-discovery hazard reason
// as fixtures/scripted-planner.js (this blocks on stdin forever).

const readline = require("node:readline");

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!request || typeof request.requestId !== "string" || !request.context) return;

  const { requestId, context } = request;
  // Integration-only cancellation probe: explicitly signal that a real,
  // initialized worker has received the request, then withhold its reply.
  // This replaces racing an arbitrary startup sleep against worker loading.
  if (process.env.HALO_FIXTURE_HOLD_RESPONSE === "1") {
    process.stderr.write(`halo fixture planner holding request:${requestId}\n`);
    return;
  }
  const criteria = (context.goal && context.goal.criteria) || [];
  const criterionId = criteria.length > 0 ? criteria[0].id : "C1";
  const observation = context.observation || {};
  const elements = observation.elements || [];
  const text = [observation.text || "", ...elements.map((element) => element.name || "")].join(" ");
  const base = {
    taskId: context.taskId,
    goalVersion: context.goalVersion,
    basedOnObservationId: observation.id || "unknown-observation",
    criterionIds: [criterionId],
  };

  let proposal;
  if (text.includes("DONE-XYZ")) {
    proposal = { ...base, kind: "finish", evidenceIds: [] };
  } else {
    const nextLink = elements.find((el) => el.role === "link" && /next/i.test(el.name || ""));
    if (nextLink) {
      proposal = { ...base, kind: "actions", actions: [{ type: "follow_link", elementId: nextLink.elementId }] };
    } else if (!observation.url || observation.url === "about:blank" || observation.url === "") {
      const match = ((context.goal && context.goal.originalRequest) || "").match(/https?:\/\/\S+/);
      proposal = match
        ? { ...base, kind: "actions", actions: [{ type: "navigate", url: match[0] }] }
        : { ...base, kind: "need_user", reason: "no URL found in goal.originalRequest" };
    } else {
      proposal = { ...base, kind: "actions", actions: [{ type: "observe" }] };
    }
  }

  process.stdout.write(`${JSON.stringify({ requestId, proposal })}\n`);
});
