"use strict";

// A routine is only a proposal source. It never receives a BrowserAdapter or
// executes a browser action. The TaskController remains responsible for policy,
// approval, dispatch, and durable advancement after a successful outcome.
const { createHash } = require("node:crypto");
const { MAX_ACTIONS_PER_PROPOSAL } = require("../../shared/harness-contracts");

class RoutineRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoutineRunnerError";
    this.code = code;
  }
}

function allowedHttpUrl(value, allowedOrigins, base) {
  let parsed;
  try {
    parsed = new URL(value, base);
  } catch {
    throw new RoutineRunnerError("routine_origin_violation", "routine URL is invalid");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !allowedOrigins.has(parsed.origin) || parsed.username || parsed.password) {
    throw new RoutineRunnerError("routine_origin_violation", "routine URL is outside its allowed origins");
  }
  return parsed;
}

function scrollAction(step) {
  const action = { type: "scroll", direction: step.direction };
  if (step.amount !== undefined) action.amount = step.amount;
  return action;
}

class RoutineRunner {
  constructor({ definition, cursor = 0, batchReadOnlySteps = false }) {
    if (!definition || !Array.isArray(definition.steps) || definition.steps.length === 0 || !Array.isArray(definition.origins) || definition.origins.length === 0) {
      throw new RoutineRunnerError("invalid_routine", "validated routine definition is required");
    }
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > definition.steps.length) {
      throw new RoutineRunnerError("routine_cursor_mismatch", "routine cursor is out of range");
    }
    for (const origin of definition.origins) {
      let parsed;
      try {
        parsed = new URL(origin);
      } catch {
        throw new RoutineRunnerError("invalid_routine", "routine origin allowlist is invalid");
      }
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
        throw new RoutineRunnerError("invalid_routine", "routine origins must be normalized HTTP(S) origins");
      }
    }
    // Keep the pinned revision stable even if its caller later edits the
    // returned store object. Definitions are bounded JSON data at this point.
    this._definition = JSON.parse(JSON.stringify(definition));
    this._cursor = cursor;
    this._batchReadOnlySteps = batchReadOnlySteps === true;
    this._allowedOrigins = new Set(this._definition.origins);
  }

  getCurrentStep() {
    const step = this._definition.steps[this._cursor];
    if (!step) return null;
    return {
      routineId: this._definition.routineId,
      revision: this._definition.revision,
      stepIndex: this._cursor,
      stepDigest: createHash("sha256").update(JSON.stringify(step)).digest("hex"),
    };
  }

  advance(binding) {
    const current = this.getCurrentStep();
    if (!current || !binding || Object.keys(current).some((key) => binding[key] !== current[key])) {
      throw new RoutineRunnerError("routine_cursor_mismatch", "routine advancement does not match the current step");
    }
    this._cursor += 1;
    return this._cursor;
  }

  async next(context) {
    if (!context || !context.observation || typeof context.observation.id !== "string") {
      throw new RoutineRunnerError("routine_step_unresolved", "current browser observation is unavailable");
    }
    const envelope = {
      taskId: context.taskId,
      goalVersion: context.goalVersion,
      basedOnObservationId: context.observation.id,
      criterionIds: [],
    };
    const step = this._definition.steps[this._cursor];
    if (!step) return { ...envelope, kind: "finish", evidenceIds: [] };

    const pageUrl = context.observation.url;
    // about:blank is only a valid launch point for an explicit navigation.
    if (!(step.kind === "navigate" && pageUrl === "about:blank")) {
      allowedHttpUrl(pageUrl, this._allowedOrigins);
    }

    let action;
    if (step.kind === "navigate") {
      allowedHttpUrl(step.url, this._allowedOrigins);
      action = { type: "navigate", url: step.url };
    } else if (step.kind === "scroll") {
      action = scrollAction(step);
      if (this._batchReadOnlySteps) {
        // Consecutive scrolls have no external effect, so the controller may run them under one durable write.
        const actions = [action];
        for (let i = this._cursor + 1; actions.length < MAX_ACTIONS_PER_PROPOSAL; i += 1) {
          const following = this._definition.steps[i];
          if (!following || following.kind !== "scroll") break;
          actions.push(scrollAction(following));
        }
        return { ...envelope, kind: "actions", actions };
      }
    } else if (step.kind === "follow_link") {
      const elements = context.observation.elements;
      if (!Array.isArray(elements)) {
        throw new RoutineRunnerError("routine_step_unresolved", "accessible links are unavailable");
      }
      const matches = elements.filter((element) => element && element.role === "link" && element.name === step.name)
        .filter((element) => {
          if (step.expectedHref === undefined) return true;
          try {
            return new URL(element.href, pageUrl).href === new URL(step.expectedHref, pageUrl).href;
          } catch {
            return false;
          }
        });
      if (matches.length !== 1 || typeof matches[0].elementId !== "string" || matches[0].elementId.length === 0) {
        throw new RoutineRunnerError("routine_step_unresolved", "link name and expected href did not identify exactly one link");
      }
      allowedHttpUrl(matches[0].href, this._allowedOrigins, pageUrl);
      action = { type: "follow_link", elementId: matches[0].elementId };
    } else {
      throw new RoutineRunnerError("invalid_routine", `unsupported routine step: ${step.kind}`);
    }
    return { ...envelope, kind: "actions", actions: [action] };
  }
}

module.exports = { RoutineRunner, RoutineRunnerError };
