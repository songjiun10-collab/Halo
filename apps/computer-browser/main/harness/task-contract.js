"use strict";
// Task Contract: before acting, the host derives what a task may touch (origins,
// deny-actions, step budget) from the user's goal alone, shows it for one approval,
// then enforces it through the existing Intent Lock. The receipt compares the
// contract with what the journal says happened. Pure helpers; no model involved.
const { makeIntentLock, normalizeLockOrigin, evaluateLock } = require("../../shared/harness-contracts");

const DEFAULT_STEP_BUDGET = 40;
const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

function safeOrigin(text) {
  try { return normalizeLockOrigin(text); } catch { return null; }
}

// Origins come only from the start URL and URLs the user typed in the goal.
// Page text and model output never widen a contract.
function draftContract({ goal, startUrl, stepBudget = DEFAULT_STEP_BUDGET, allowPurchase = false }) {
  const origins = new Set();
  const start = startUrl ? safeOrigin(startUrl) : null;
  if (start) origins.add(start);
  for (const m of String(goal || "").match(URL_RE) || []) {
    const o = safeOrigin(m.replace(/[.,;]+$/, ""));
    if (o) origins.add(o);
  }
  if (origins.size === 0) return { lock: null, origins: [], stepBudget, reason: "no_origin_in_goal" };
  const rules = [{ kind: "allow_origins", origins: [...origins] }];
  if (!allowPurchase) rules.push({ kind: "deny_action", action: "submit_form" });
  return { lock: makeIntentLock({ rules }), origins: [...origins].sort(), stepBudget, allowPurchase: !!allowPurchase };
}

// What the user is shown once, in plain words.
function describeContract(c) {
  if (!c.lock) return "No sites could be derived from your request, so this task runs without a site limit and asks before risky steps.";
  const lines = [`Allowed sites: ${c.origins.join(", ")}`, `Step budget: ${c.stepBudget}`];
  lines.push(c.allowPurchase ? "Form submissions: allowed" : "Form submissions: blocked unless you approve them");
  return lines.join("\n");
}

// attempts: [{ action, targetOrigin }]. Returns what the contract would have allowed or blocked.
function contractReceipt(contract, attempts) {
  const allowed = [];
  const blocked = [];
  attempts.forEach((a, i) => {
    const verdict = evaluateLock(contract.lock, a);
    (verdict.allowed ? allowed : blocked).push({ index: i, ...a, ...(verdict.allowed ? {} : { reason: verdict.reason }) });
  });
  return { digest: contract.lock?.digest ?? null, withinBudget: attempts.length <= contract.stepBudget, allowed, blocked };
}

module.exports = { draftContract, describeContract, contractReceipt, DEFAULT_STEP_BUDGET };
