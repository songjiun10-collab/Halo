"use strict";
const { capturePreferredObservation } = require("./computer-use-observation");
const { startTurnMemoryReads } = require("./turn-memory-preparation");

// The long-running task state machine (design doc sections 5-7): drives
// observe -> plan -> approve -> execute -> verify -> checkpoint, one action
// dispatch at a time, rebuilding the planner's entire context from durable
// state every call (never from an in-process transcript) so the goal
// survives any number of context resets. Every dependency is injected --
// store (Task 1), planner (Task 3's PlannerStdioAdapter or a fake/scripted
// one), browser (Task 4's real adapter or a fake), approve (Task 4's real
// approver client or a fake), hostVerifier (progress.js's deterministic
// verifier), memoryMonitor (Task 5's real one or a no-op) -- so this file
// has no direct dependency on Electron, a real approver process, or a real
// model.
//
// Memory discipline (design doc section 10): the only state held in memory
// here is the current goal, a small progress/budget summary, and a bounded
// no-progress-detection window -- never the full action/observation
// history (that lives in the durable journal, read back only in small
// bounded slices via context-builder.js).

const { randomUUID } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const contracts = require("../../shared/harness-contracts");
const { validateHarnessProfile, selectHarnessProfile, maxActionsPerProposal, isQuickProfile } = require("../../shared/harness-profile");
const { adaptiveEffort } = require("./planner-effort-policy");
const { createRecoveryPolicy, buildRecoveryFeedback, buildProposalFeedback } = require("./recovery-policy");
const { resolveTarget } = require("./screen-map");
const { privateOriginsNamedIn } = require("./private-network");
const { TaskBranchManager } = require("./task-branch-manager");
const { classifyTarget } = require("./effect-classifier");
const { inspectAction } = require("./action-safety");
const { applyPrivacyTiers, containsTier3, hasSecretSurface, maskTier3 } = require("./pii-tiers");
const payments = require("./payment-mandate");
const research = require("./research-sources");
const { buildContext } = require("./context-builder");
const { ContextRefCatalog } = require("./context-refs");
const { validateProposal, verifyCriterion, canComplete } = require("./progress");
const { isReadOnlyAction } = require("./permission-policy");
const { looksLikeCaptcha } = require("../../shared/captcha-heuristics");
const { evaluateGate, actionTargetOrigin } = require("./action-gate");
const { LEASE_ACTIONS, lendTerms, createLease, isLeaseLive, LeaseError } = require("./capability-lease");

class TaskControllerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TaskControllerError";
    this.code = code;
  }
}

const NOOP_MEMORY_MONITOR = { getPressureLevel: () => "normal" };

// A human (or the policy approver's secret scanner) reviewing an approval
// request needs to see WHAT the action targets, not just its type and the
// page it was proposed from -- otherwise a navigate/follow_link/scroll is
// approved blind. Only derived from the host's own last observation, never
// from planner-supplied free text.
function describeActionTarget(action, lastObservation, screenTargets = null) {
  if (action.type === "navigate") {
    return typeof action.url === "string" ? action.url : null;
  }
  if (action.type === "follow_link") {
    const element = lastObservation?.elements?.find((el) => el.elementId === action.elementId);
    if (element && typeof element.href === "string") return element.href;
    return typeof action.elementId === "string" ? `element ${action.elementId}` : null;
  }
  if (action.type === "http_get") {
    return typeof action.url === "string" ? action.url.slice(0, 300) : null;
  }
  if (action.type === "find_text") {
    return typeof action.text === "string" ? JSON.stringify(action.text.slice(0, 80)) : null;
  }
  if (action.type === "scroll") {
    const direction = typeof action.direction === "string" ? action.direction : "?";
    const amount = action.amount !== undefined ? String(action.amount) : "?";
    return `${direction} ${amount}`;
  }
  if (["click", "type", "select_option", "submit_form"].includes(action.type)) {
    const element = lastObservation?.elements?.find((el) => el.elementId === action.elementId);
    if (!element) return `unknown element ${String(action.elementId).slice(0, 32)}`;
    const identity = `${element.role || "element"} ${JSON.stringify(element.name || "")} [${element.elementId}]`;
    if (action.type === "select_option") return `${identity}; choose ${JSON.stringify(typeof action.label === "string" ? action.label.slice(0, 120) : "")}`;
    if (action.type === "type") return `${identity}; replace text with ${JSON.stringify(action.text)}`;
    const destination = element.formAction ? `${(element.formMethod || "get").toUpperCase()} ${element.formAction}` : element.href;
    return destination ? `${identity}; ${destination}` : identity;
  }
  const landed = (observation) => {
    // Text computer use only: name the control under the point so the approver
    // sees "Delete" instead of bare coordinates. Derived from host geometry.
    if (!screenTargets || screenTargets.observationId !== (observation?.id || action.observationId)) return "";
    const hit = resolveTarget(screenTargets.targets, Number(action.x), Number(action.y));
    if (!hit) return " -> no mapped control";
    const flags = [hit.covered ? "covered" : "", hit.disabled ? "disabled" : ""].filter(Boolean).join(",");
    return ` -> ${hit.role} ${JSON.stringify(hit.name)}${flags ? ` [${flags}]` : ""}`;
  };
  if (action.type === "press_key") return `${lastObservation?.id || action.observationId}; press ${action.key}`;
  if (action.type === "play_loop") return `${lastObservation?.id || action.observationId}; play for up to ${action.seconds}s, pressing ${[...new Set(action.lanes.map((l) => l.key))].join(" ")} when its lane shows a note`;
  if (["click_at", "type_at"].includes(action.type)) {
    const point = `(${Math.round(Number(action.x) * 100)}%, ${Math.round(Number(action.y) * 100)}%)`;
    const where = landed(lastObservation);
    return action.type === "type_at" ? `screenshot ${lastObservation?.id || action.observationId} ${point}${where}; insert ${JSON.stringify(action.text)}` : `screenshot ${lastObservation?.id || action.observationId} ${point}${where}`;
  }
  return null;
}

function observationKey(observation) {
  // A comparison key for no-progress detection, not a cryptographic hash --
  // it only needs to be deterministic and cheap to compare. The real
  // BrowserAdapter stamps every observation with a fresh random `id`
  // (_randomId()), so that field must be excluded here -- otherwise no two
  // observations of the identical page would ever compare equal and the
  // no-progress safety net would never fire against a real browser.
  if (!observation || typeof observation !== "object") return String(observation);
  const { id, ...rest } = observation;
  try {
    return JSON.stringify(rest);
  } catch {
    return String(observation);
  }
}

// Capability adapters are host-validated as part of the durable task profile.
// Team parents include CUA; child profiles do not, preserving their
// observe-only boundary while allowing the parent to request human review.
function hasComputerUseAdapter(taskProfile) {
  return Array.isArray(taskProfile?.capability?.adapters) &&
    taskProfile.capability.adapters.some((adapter) => adapter?.capabilityId === "computer_use");
}

// Auto-run only what cannot carry an external effect on its own. With a text
// screen map the control under the point is classified by meaning (Delete, Buy,
// Send ... go to the human); in image mode there is no geometry yet, so
// coordinate clicks keep the action-type rule.
function isAutoComputerUseAction(action, taskProfile, screenTargets = null) {
  if (!hasComputerUseAdapter(taskProfile)) return false;
  if (action.type === "press_key") return action.key !== "Enter";
  if (action.type !== "click_at" && action.type !== "type_at") return false;
  if (!screenTargets) return true;
  if (screenTargets.observationId !== action.observationId) return false;
  const hit = resolveTarget(screenTargets.targets, Number(action.x), Number(action.y));
  return classifyTarget(hit, action.type).gate === "auto";
}

// Same idea for DOM actions: a click on a link/tab/menu item or a button that
// only moves around the page, or typing into an ordinary text field, cannot
// carry an external effect on its own, so the approver alone decides. Anything
// the classifier flags (Send, Buy, Delete ...), cannot rule out, or any
// password field keeps the human gate.
function isAutoDomAction(action, observation) {
  if (action.type !== "click" && action.type !== "type") return false;
  const element = observation?.elements?.find((el) => el.elementId === action.elementId);
  if (!element || typeof element.role !== "string") return false;
  if (action.type === "type" && element.inputType === "password") return false;
  if (action.type === "click" && element.formAction) return false;
  const target = { role: element.role, name: typeof element.name === "string" ? element.name : "", covered: false, disabled: !!element.disabled };
  return classifyTarget(target, action.type === "type" ? "type_at" : "click_at").gate === "auto";
}

function hasMultiAgentCapability(taskProfile) {
  return ["multi_agent", "multi_agent_computer_use"].includes(taskProfile?.capability?.id);
}

// Long-profile goal persistence: total finish proposals the host will reject
// (criteria still unmet, all machine-verifiable) before pausing for a human.
const GOAL_MAX_REJECTED_FINISHES = 5;
// A research answer plus the host's own source list is longer than an ordinary reply.
const RESEARCH_REASON_CAP = 2800;
const NAV_VISITED_MAX = 16;
// Consecutive scrolls on one page after which the task pauses as no_progress.
const PLANNER_RETRYABLE_CODES = ["invalid_proposal", "invalid_proposal_json"];
const SCROLL_STREAK_LIMIT = 6;
// A random delay in seconds between min and max, rounded to 5 decimal places.
function clickDelaySeconds(min, max, roll) {
  return Math.round((min + roll * (max - min)) * 1e5) / 1e5;
}
// Planner turns spent on one page (query and hash ignored) within the recent window.
const PAGE_LOOP_WINDOW = 12;
const VISITED_PAGES_KEPT = 500;
// Minimum gap between page loads on the same site; keeps agent browsing polite and less likely to trip bot checks.
const SAME_SITE_NAV_INTERVAL_MS = 1500;
// Sites that may show a human check before the task is handed to the person.
const CAPTCHA_SITES_TRIED = 4;
const PAGE_LOOP_LIMIT = 8;
const ERROR_URLS_KEPT = 5;
const OBSERVE_STALE_RETRIES = 2;
const OBSERVE_RETRY_DELAY_MS = 400;
const NAV_FRONTIER_MAX = 12;
const NAV_URL_MAX_CHARS = 512;
const NAV_NAME_MAX_CHARS = 50;
const MCP_RESULT_MAX_BYTES = 4096;

function truncateUtf8(text, maxBytes) {
  const source = Buffer.from(String(text), "utf8");
  if (source.length <= maxBytes) return { text: source.toString("utf8"), truncated: false };
  let end = maxBytes;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return { text: source.subarray(0, end).toString("utf8"), truncated: true };
}

function plannerMcpAction(action) {
  if (!contracts.isPlainObject(action) || typeof action.type !== "string" || !action.type.startsWith("mcp_")) return false;
  const fields = {
    mcp_search: ["type", "query"],
    mcp_describe: ["type", "connectionId", "toolName"],
    mcp_propose: ["type", "connectionId", "toolName", "arguments", "reason"],
  }[action.type];
  if (!fields || Object.keys(action).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(action, key))) return false;
  if (action.type === "mcp_search") return typeof action.query === "string" && action.query.trim().length > 0 && Buffer.byteLength(action.query, "utf8") <= 1024;
  if (typeof action.connectionId !== "string" || !action.connectionId || action.connectionId.length > 256 ||
      typeof action.toolName !== "string" || !action.toolName || action.toolName.length > 256) return false;
  if (action.type === "mcp_describe") return true;
  try {
    contracts.validateMcpProposal({ connectionId: action.connectionId, toolName: action.toolName, arguments: action.arguments });
  } catch { return false; }
  return typeof action.reason === "string" && action.reason.trim().length > 0 && action.reason.length <= 2000;
}

// P1 context_read: one host-only read of manifest refs, exact keys only.
function plannerContextRead(action) {
  return contracts.isPlainObject(action) && action.type === "context_read"
    && Object.keys(action).every((key) => key === "type" || key === "refIds")
    && Array.isArray(action.refIds) && action.refIds.length > 0 && action.refIds.length <= 4
    && action.refIds.every((id) => typeof id === "string" && id.length <= 128);
}

function mcpActionKind(action) {
  return action.type.slice("mcp_".length);
}

function boundedMcpObservation(action, outcome, result = "", extra = {}) {
  const base = { authority: "untrusted_mcp", action, outcome, truncated: false, ...extra };
  const json = JSON.stringify({ ...base, result: String(result) });
  if (Buffer.byteLength(json, "utf8") <= MCP_RESULT_MAX_BYTES) return { ...base, result: String(result) };
  const overhead = Buffer.byteLength(JSON.stringify({ ...base, result: "" }), "utf8");
  const bounded = truncateUtf8(result, Math.max(0, MCP_RESULT_MAX_BYTES - overhead - 20));
  let candidate = { ...base, truncated: true, result: bounded.text };
  while (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MCP_RESULT_MAX_BYTES && candidate.result.length > 0) {
    candidate = { ...candidate, result: truncateUtf8(candidate.result, Math.max(0, Buffer.byteLength(candidate.result, "utf8") - 8)).text };
  }
  return candidate;
}

function isMcpItem(item) {
  return item.actionType === contracts.MCP_CALL_ACTION_TYPE && !!item.mcp;
}

class TaskController {
  constructor({
    store,
    planner,
    browser,
    osComputerUse = null,
    releaseViewsOnReview = false,
    approve,
    hostVerifier,
    memoryMonitor,
    now,
    monotonicNow,
    segmentRotationCalls,
    noProgressThreshold,
    pageStallLimit,
    memoryStore,
    activityRecall,
    strategyGuidance,
    branchRunner,
    branchLimits,
    permissionMode = "browse",
    observeRetryDelayMs = OBSERVE_RETRY_DELAY_MS,
    navIntervalMs = SAME_SITE_NAV_INTERVAL_MS,
    clickDelayMinSec = 0,
    clickDelayMaxSec = 0,
    random = Math.random,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    finishEvidenceRejections = 0,
    repeatFailureLimit = 0,
    giveUpRefusals = 0,
    groundAnswers = false,
    completionChecklist = null,
    maxRecoveries,
    plannerImageInput = true,
    visionAssist = null,
    escalatePlanner = null,
    plannerEffort = "medium",
    adaptiveEffort: adaptiveEffortEnabled = false,
    onChildPlan,
    sendMessage,
    listPendingMessages,
    recordMessagesConsumed,
    readTeamBoard,
    readChildPlan,
    readWorkGoalContext,
    routineRunner,
    routineRun,
    batchReadOnlyActions = true,
    paymentsEnabled = false,
    requestAuthor = "person",
    harnessProfile,
    makeMcpBroker,
    mcpEnabled,
    reviewFallback = "queue",
    onTiming,
    contextRefs = false,
  } = {}) {
    if (!store) throw new TaskControllerError("invalid_config", "store is required");
    if (!planner) throw new TaskControllerError("invalid_config", "planner is required");
    if (!browser) throw new TaskControllerError("invalid_config", "browser is required");
    if (!approve) throw new TaskControllerError("invalid_config", "approve is required");
    if (!hostVerifier) throw new TaskControllerError("invalid_config", "hostVerifier is required");
    if (reviewFallback !== "queue" && reviewFallback !== "deny") {
      throw new TaskControllerError("invalid_config", "reviewFallback must be queue or deny");
    }
    // "deny" is the unattended-run choice: nobody is watching, so an action
    // that would wait for a human is denied (and journaled) instead.
    this._reviewFallback = reviewFallback;
    // Telemetry only (P0 measurement): {operation: "context_build", elapsedMs,
    // bytes}. Never changes what runs; a throwing callback is ignored.
    if (onTiming !== undefined && typeof onTiming !== "function") {
      throw new TaskControllerError("invalid_config", "onTiming must be a function when provided");
    }
    this._onTiming = onTiming || null;
    // P1 context manifest, opt-in: pages already left stay readable by ref
    // through a host-only context_read action. Off leaves the packet as before.
    if (typeof contextRefs !== "boolean") {
      throw new TaskControllerError("invalid_config", "contextRefs must be a boolean");
    }
    this._contextRefsEnabled = contextRefs;
    this._contextRefs = null;
    this._contextRefsPage = null; // the page the last manifest was built on
    this._pageRefs = new Map(); // url -> refId of its latest snapshot
    this._pendingContextRead = null;

    this._store = store;
    this._planner = planner;
    this._routineRunner = routineRunner || null;
    this._batchReadOnlyActions = batchReadOnlyActions !== false;
    // Opt-in: payments stay refused unless the host explicitly passes true (fail closed).
    if (requestAuthor !== "person" && requestAuthor !== "model") throw new TaskControllerError("invalid_config", "requestAuthor must be person or model");
    // A request a model wrote (a team room's propose_task) is never the person's payment order.
    this._requestAuthor = requestAuthor;
    this._paymentsEnabled = paymentsEnabled === true;
    const checkpointedRoutineRun = store.lastCheckpoint?.payload?.routineRun;
    this._routineRun = checkpointedRoutineRun ? { ...checkpointedRoutineRun } : routineRun ? { ...routineRun } : null;
    if (this._routineRunner && (!this._routineRun ||
        typeof this._routineRun.routineId !== "string" ||
        !Number.isInteger(this._routineRun.revision) ||
        typeof this._routineRun.digest !== "string" ||
        !Number.isInteger(this._routineRun.cursor) || this._routineRun.cursor < 0)) {
      throw new TaskControllerError("invalid_routine", "routine runner requires a pinned routine ID, revision, digest, and cursor");
    }
    // TaskHost/_attach is the profile-selection authority, never the model or
    // the task's own text; this constructor only validates what it's given.
    // A durably checkpointed harnessProfile (see _checkpoint()) always wins
    // on reattach/recovery, exactly like _routineRun above -- otherwise an
    // explicit "long" chosen at task creation would silently fall back to
    // _attach()'s stateless default (isRoutine-based) after every restart,
    // which is precisely the "durable continuation" property Long exists
    // for. See docs/superpowers/plans/2026-09-29-harness-profiles-v2-phase3.md.
    const checkpointedHarnessProfile = store.lastCheckpoint?.payload?.harnessProfile;
    this._harnessProfile = validateHarnessProfile(
      checkpointedHarnessProfile !== undefined
        ? checkpointedHarnessProfile
        : harnessProfile !== undefined
          ? harnessProfile
          : selectHarnessProfile({ isRoutine: this._routineRun !== null }),
    );
    // Fixed for the task's lifetime (no setter exists) -- computed once here
    // rather than on every proposal validation in the hot per-turn loop.
    this._maxActionsPerProposal = maxActionsPerProposal(this._harnessProfile);
    // Long only: /goal-style persistence. Recover the count from both the
    // checkpoint and its journal tail: a crash can happen after the durable
    // finish_rejected append but before the next checkpoint.
    const checkpointedRejected = store.lastCheckpoint?.payload?.goalPersistence?.rejectedFinishes;
    let recoveredRejected = Number.isInteger(checkpointedRejected) && checkpointedRejected >= 0 && checkpointedRejected <= GOAL_MAX_REJECTED_FINISHES
      ? checkpointedRejected
      : 0;
    // A process can die after the durable finish_rejected note append but
    // before the next checkpoint. TaskStore.load() exposes that validated
    // journal tail as eventsSinceCheckpoint; include it so recovery cannot
    // reset the bounded rejection loop through a crash/restart cycle.
    for (const event of store.eventsSinceCheckpoint || []) {
      if (event.type !== "note" || event.payload?.kind !== "finish_rejected") continue;
      const count = event.payload.rejectedFinishes;
      if (!Number.isInteger(count) || count !== recoveredRejected + 1 || count > GOAL_MAX_REJECTED_FINISHES) {
        throw new TaskControllerError("invalid_goal_persistence", "durable finish rejection history is inconsistent");
      }
      recoveredRejected = count;
    }
    this._rejectedFinishes = recoveredRejected;
    // Research tasks: the pages this host opened (the only sources an answer may cite) and how many
    // answers were sent back. Both are rebuilt from the journal, so a restart cannot reset the loop.
    this._researchLedger = null;
    this._researchRejections = 0;
    this._researchFeedback = null;
    // Generic MCP scope exists only when the trusted host supplies a broker
    // factory. Open calls (durable mcp_call_started without an outcome) are
    // recovered from the checkpoint plus the journal tail, like finish
    // rejections above, so a crash mid-call can never be silently resumed.
    this._makeMcpBroker = typeof makeMcpBroker === "function" ? makeMcpBroker : null;
    this._mcpBroker = null;
    this._mcpClosed = false;
    this._plannerMcpEnabled = typeof mcpEnabled === "boolean" ? mcpEnabled : Boolean(this._makeMcpBroker);
    this._mcpContext = new AsyncLocalStorage();
    this._openMcpCalls = new Set();
    const checkpointedOpenMcp = store.lastCheckpoint?.payload?.mcp?.openCalls;
    if (checkpointedOpenMcp !== undefined) {
      if (!Array.isArray(checkpointedOpenMcp) || !checkpointedOpenMcp.every((id) => typeof id === "string" && contracts.UUID_RE.test(id))) {
        throw new TaskControllerError("invalid_mcp_recovery", "checkpointed open MCP calls are malformed");
      }
      for (const id of checkpointedOpenMcp) this._openMcpCalls.add(id);
    }
    for (const event of store.eventsSinceCheckpoint || []) {
      if (event.type !== "note") continue;
      if (event.payload?.kind === "mcp_call_started") this._openMcpCalls.add(event.payload.requestId);
      if (event.payload?.kind === "mcp_call_outcome") this._openMcpCalls.delete(event.payload.requestId);
    }
    this._browser = browser;
    this._osComputerUse = osComputerUse;
    this._approve = approve;
    this._hostVerifier = hostVerifier;
    // Multi-agent background runtime plan, Task 4: only a PARENT controller
    // is ever constructed with this -- a child controller (built exclusively
    // by ChildAgentCoordinator._attachChild) never receives it, so a
    // child_plan proposal reaching a child's own loop (which should already
    // be impossible -- its PlannerStdioAdapter's role:"child" rejects that
    // proposal kind at the wire boundary) has no delegation path here either.
    // No nested child agents (Global Constraints): a child controller can
    // never itself accept a child_plan.
    this._onChildPlan = typeof onChildPlan === "function" ? onChildPlan : null;
    // Subagent communication protocol Task 4: host-derived envelope/relation-
    // ship authority lives in ChildAgentCoordinator (task-host.js/child-
    // agent-coordinator.js wire these), never here -- this controller only
    // knows how to fetch its own pending messages, ask the planner, and
    // durably acknowledge what it admitted, symmetrically for a parent's own
    // top-level controller and a child's controller.
    this._sendMessage = typeof sendMessage === "function" ? sendMessage : null;
    this._listPendingMessages = typeof listPendingMessages === "function" ? listPendingMessages : null;
    this._recordMessagesConsumed = typeof recordMessagesConsumed === "function" ? recordMessagesConsumed : null;
    // A child's team board (ChildAgentCoordinator.readTeamBoard): advisory
    // sibling notes, so a failed read only leaves them out of this turn.
    this._readTeamBoard = typeof readTeamBoard === "function" ? readTeamBoard : null;
    // A parent's current child plan summary (ChildAgentCoordinator.
    // getPlanSummary), so its planner is told whether splitting the work is
    // open or a plan is already running. Read only when this controller can
    // actually accept a child_plan.
    this._readChildPlan = typeof readChildPlan === "function" ? readChildPlan : null;
    // The binding is durable TaskStore state. The injected reader is only a
    // host-owned lookup for that exact version; it cannot choose a different
    // Goal for this Task or modify the Task's own GoalSpec.
    this._workGoalBinding = store.taskProfile?.workGoalBinding ? { ...store.taskProfile.workGoalBinding } : null;
    this._readWorkGoalContext = typeof readWorkGoalContext === "function" ? readWorkGoalContext : null;
    this._memoryMonitor = memoryMonitor || NOOP_MEMORY_MONITOR;
    this._memoryStore = memoryStore || null;
    this._activityRecall = typeof activityRecall === "function" ? activityRecall : null;
    this._strategyGuidance = typeof strategyGuidance === "string" && strategyGuidance.length <= 4096 ? strategyGuidance : null;
    // Task Branches: read-only side reads while an approval waits. Off unless the
    // host supplies a runner; the manager is the whole safety envelope.
    this._branches = typeof branchRunner === "function"
      ? new TaskBranchManager({
        runner: branchRunner,
        ...(branchLimits ?? {}),
        onEvent: (kind, payload) => { void this._store.append({ type: "note", payload: { kind, ...payload } }).catch(() => {}); },
        onChange: () => this._emit(),
      })
      : null;
    const { PERMISSION_MODES, evaluateActionPolicy } = require("./permission-policy");
    if (!PERMISSION_MODES.includes(permissionMode)) throw new TaskControllerError("invalid_config", "permissionMode is invalid");
    this._permissionMode = permissionMode;
    // Steps that ran without asking the user (approver-only or lease). Session-local, for the report.
    this._autoHandled = 0;
    this._observeRetryDelayMs = Number.isFinite(observeRetryDelayMs) && observeRetryDelayMs >= 0 ? observeRetryDelayMs : OBSERVE_RETRY_DELAY_MS;
    this._plannerEffort = plannerEffort;
    this._adaptiveEffort = adaptiveEffortEnabled === true;
    this._seenUrls = new Set();
    this._lastActionType = undefined;
    this._lastActionStatus = undefined;
    this._easyStreak = 0;
    this._evaluateActionPolicy = evaluateActionPolicy;
    this._browser.setPermissionMode?.(permissionMode);
    this._now = typeof now === "function" ? now : Date.now;
    this._monotonicNow = typeof monotonicNow === "function"
      ? monotonicNow
      : () => Number(process.hrtime.bigint()) / 1_000_000;
    this._segmentRotationCalls =
      typeof segmentRotationCalls === "number" ? segmentRotationCalls : contracts.SEGMENT_ROTATION_CALLS;
    this._pageStallLimit = typeof pageStallLimit === "number" ? pageStallLimit : PAGE_STALL_LIMIT;
    this._noProgressThreshold =
      typeof noProgressThreshold === "number" ? noProgressThreshold : contracts.NO_PROGRESS_REPLAN_THRESHOLD;

    this._goal = store.getGoal();
    // Leases live only as long as this controller: a restarted task starts
    // with none, which is stricter than replaying them from the journal.
    this._leases = [];
    // Payment Mandates made from the user's own chat request (see payment-mandate.js). Not restored after a restart.
    this._mandates = [];
    this._mandateGoalVersion = null;
    this._browser.setIntentLock?.(this._goal.lock ?? null);
    this._browser.setPrivateNetworkAllowance?.(this._personNamedPrivateOrigins());
    this._epoch = 0;
    this._loopRunning = false;
    this._plannerAborter = null;
    this._plannerShutdownRequired = false;
    this._listeners = new Set();
    this._lastEmittedSnapshot = null;
    this._pendingCheckpoints = 0;
    this._snapshotTrusted = true;

    // Transition admission gate (2026-09-27 concurrent-takeover fix): every
    // externally-invoked mutator (approve/deny/amend/confirmCriterion) must
    // synchronously see this closed the instant pause()/stop()/takeOver() is
    // CALLED -- not once its queued _doTransition eventually runs, since
    // _enqueueTransition defers via Promise.then and a synchronous caller
    // could otherwise slip an approve() through the gap. _admissionOpen is
    // therefore set to false synchronously inside pause()/stop()/takeOver()
    // themselves, and only ever reopened at the tail of _doTransition, after
    // its checkpoint durably succeeds, and only when no further transition
    // is still queued behind it (see _pendingTransitions).
    this._admissionOpen = true;
    this._pendingTransitions = 0;
    this._transitionChain = Promise.resolve();
    // Every admitted mutating operation that can independently touch the
    // durable journal outside the loop's own iteration -- approve()'s own
    // dispatch AND the loop's own internal dispatch inside
    // _dispatchActionsBatch -- registers its promise here so a transition's
    // drain step waits for its TRUE outcome before checkpointing, rather
    // than racing it (see _dispatchApprovedTracked).
    this._inFlightOps = new Set();

    this._budgets = { actionsUsed: 0, plannerCallsUsed: 0, activeMs: 0 };
    this._activeSince = null;
    this._segment = { index: 0, callsInSegment: 0 };
    this._criteriaStatus = new Map(); // criterionId -> {status, evidenceId}
    this._noProgress = { lastKey: null, consecutive: 0, hasReplannedOnce: false };
    this._scrollStreak = { url: null, count: 0 };
    this._textFocusQueries = []; // recent find_text queries: their words keep matching passages in the planner's page text
    this._recentPages = [];
    this._visitedPages = new Set();
    this._lastNavAt = new Map();
    this._captchaOrigins = new Set();
    this._captchaNudges = 0;
    this._captchaNudgePending = false;
    this._onCaptchaPage = false;
    // A click is sent after a random pause between min and max seconds, to 5 decimal places (0.23817 s), as a
    // person's pointer does not land the instant the page changes. Off (0) unless the host sets it; the pause is
    // also a brief settle time for page scripts.
    const delayOk = (value) => Number.isFinite(value) && value >= 0 && value <= 5;
    this._clickDelay = delayOk(clickDelayMinSec) && delayOk(clickDelayMaxSec) && clickDelayMaxSec >= clickDelayMinSec && clickDelayMaxSec > 0
      ? { min: clickDelayMinSec, max: clickDelayMaxSec } : null;
    this._random = typeof random === "function" ? random : Math.random;
    this._sleep = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    this._navIntervalMs = Number.isFinite(navIntervalMs) ? navIntervalMs : SAME_SITE_NAV_INTERVAL_MS;
    // A finish with no recorded evidence for any criterion is sent back this many times before it is accepted
    // (measured in the compare20 runs: 10 of 15 Haiku finishes had no evidence observe, and all 3 plainly wrong ones were among them).
    this._finishEvidenceBudget = Number.isInteger(finishEvidenceRejections) && finishEvidenceRejections >= 0 ? finishEvidenceRejections : 0;
    this._finishEvidenceRejections = 0;
    this._finishFeedback = null;
    // An identical action that already failed this many times with a deterministic error is not dispatched again
    // (compare20: 16 identical failing navigates, 12 identical failing selects). 0 = off.
    this._repeatFailureLimit = Number.isInteger(repeatFailureLimit) && repeatFailureLimit >= 0 ? repeatFailureLimit : 0;
    this._repeatFailures = new Map();
    this._repeatBlocked = 0;
    this._repeatFeedback = null;
    // The last actions' families (see actionFamily): the same kind of action over and over is a loop even when
    // each one differs a little (another search phrase, another passage), so the exact-repeat check misses it.
    this._familyWindow = [];
    // Benchmark option: how many times a need_user that is not a source-checked answer is sent back before it is honoured.
    this._giveUpRefusals = Number.isInteger(giveUpRefusals) && giveUpRefusals > 0 ? giveUpRefusals : 0;
    this._giveUpRefused = 0;
    // Benchmark option: apply the source-checked answer path to every task, not only research ones.
    this._groundAnswers = groundAnswers === true;
    // Benchmark option: a function ({ answer, goalText, observation, observedTexts }) -> { ok, failures } run on every reported answer.
    this._completionChecklist = typeof completionChecklist === "function" ? completionChecklist : null;
    this._completionRejected = 0;
    this._observedTexts = new Map();
    this._needUserReason = null;
    this._maxRecoveries = maxRecoveries;
    this._proposalFeedbackCode = null;
    this._rejectedProposals = 0;
    this._recovery = createRecoveryPolicy(maxRecoveries, undefined, { state: store.lastCheckpoint?.payload?.recoveryBudget });
    for (const event of store.eventsSinceCheckpoint || []) {
      if (event.type !== "note" || event.payload?.kind !== "recovery") continue;
      const state = event.payload.recoveryBudget;
      if (state === undefined) continue; // Legacy notes had no durable budget.
      const restored = createRecoveryPolicy(maxRecoveries, undefined, { state });
      if (restored.snapshot().spent !== this._recovery.snapshot().spent + 1) {
        throw new TaskControllerError("invalid_recovery_state", "recovery journal tail is inconsistent");
      }
      this._recovery = restored;
    }
    // A planner without image input gets a text screen map instead of a
    // screenshot (text computer use). visionAssist, when given, may describe
    // the screen for sparse pages; its output is untrusted text.
    this._plannerImageInput = plannerImageInput !== false;
    this._screenTargets = null;
    // Opt-in: when same-model recovery is spent on a planner problem, the host
    // may hand back a stronger planner. At most once per task.
    this._escalatePlanner = typeof escalatePlanner === "function" ? escalatePlanner : null;
    this._escalations = store.lastCheckpoint?.payload?.plannerEscalations ?? 0;
    if (!Number.isInteger(this._escalations) || this._escalations < 0 || this._escalations > 1) {
      throw new TaskControllerError("invalid_recovery_state", "planner escalation count is malformed");
    }
    for (const event of store.eventsSinceCheckpoint || []) {
      if (event.type === "note" && event.payload?.kind === "planner_escalation") this._escalations = 1;
    }
    this._visionAssist = typeof visionAssist === "function" ? visionAssist : null;
    this._loopHint = false;
    this._errorUrls = [];
    this._approvalQueue = [];
    this._lastObservation = null;
    this._viewsReleased = false;
    this._releaseViewsOnReview = releaseViewsOnReview === true;
    this._pendingMcpObservation = null;
    // Reusable-across-turns iff the last dispatched action was itself an
    // "observe" (see the reuse gate in the main loop and its assignment in
    // _afterActionDispatched, which is this field's one source of truth).
    this._reusableObservation = null;
    // Host-owned navigation memory for the planner: pages actually visited and
    // links seen but not yet visited. Without it a planner at a dead end has
    // no way to know where it came from or what is left to try. In-memory
    // only: a restarted controller re-discovers it from fresh observations.
    this._navigation = { visited: [], frontier: [] };

    // A task that already reached a TERMINAL state (completed/stopped) was
    // checkpointed synchronously the instant it got there (see the
    // "completed" transition below and confirmCriterion()), so the last
    // checkpoint is authoritative and must win over recoveryReason --
    // otherwise every reload (2026-09-27 follow-up, found while verifying
    // the real-Electron 3-page journey) reports an already-finished task as
    // plain "paused"/"recovered", indistinguishable from one merely
    // interrupted mid-flight. That is not just a mislabel: resume() accepts
    // any "paused" state unconditionally, so a caller correctly following
    // the paused->resume() protocol would re-invoke the planner/browser on
    // a task that has nothing left to do. Only completed/stopped are
    // restored this way -- awaiting_verification is intentionally left to
    // the existing recovered/execution_uncertain derivation below (deciding
    // how confirmCriterion() should interact with a peeked, not-yet-
    // attached awaiting_verification task is a separate, broader question,
    // not addressed here).
    const checkpointedTask = store.lastCheckpoint && store.lastCheckpoint.payload && store.lastCheckpoint.payload.task;
    if (checkpointedTask && (checkpointedTask.state === "completed" || checkpointedTask.state === "stopped")) {
      this._task = { state: checkpointedTask.state, pauseReason: checkpointedTask.pauseReason ?? null };
      return;
    }

    // Initial state comes from how the store itself was opened -- a freshly
    // created task starts idle; anything loaded back off disk starts paused
    // so nothing auto-resumes without an explicit human decision (design
    // doc section 4: "재시작으로 복구된 task는 자동 출발하지 않고
    // paused: recovered/execution_uncertain에서 사용자 resume을 받는다").
    if (store.recoveryReason === "execution_uncertain") {
      this._task = { state: "paused", pauseReason: "execution_uncertain" };
    } else if (store.recoveryReason === "recovered") {
      this._task = { state: "paused", pauseReason: "recovered" };
    } else {
      this._task = { state: "idle", pauseReason: null };
    }
    if (this._openMcpCalls.size > 0) {
      this._task = { state: "paused", pauseReason: "execution_uncertain" };
    }

    // A nonterminal checkpoint still carries real progress -- restore it
    // rather than let the freshly constructed zero budgets/segment/criteria
    // silently replace it, which would let a recovered task exceed its
    // action/planner-call/time limits or re-derive already-verified
    // criteria as pending.
    const checkpointedPayload = store.lastCheckpoint && store.lastCheckpoint.payload;
    if (checkpointedPayload) {
      if (checkpointedPayload.budgets) this._budgets = { ...checkpointedPayload.budgets };
      if (checkpointedPayload.segment) this._segment = { ...checkpointedPayload.segment };
      if (checkpointedPayload.criteriaStatus) this._criteriaStatus = new Map(checkpointedPayload.criteriaStatus);
    }
    if (this._routineRunner && this._routineRun && store.routineRecovery) {
      const recovered = store.routineRecovery;
      if (recovered.routineId !== this._routineRun.routineId || recovered.revision !== this._routineRun.revision || recovered.digest !== this._routineRun.digest) {
        throw new TaskControllerError("routine_cursor_mismatch", "recovered routine pin differs from its checkpoint");
      }
      this._routineRun.cursor = recovered.cursor;
      if (recovered.blocked === "denied") {
        this._routineRun.blocked = "denied";
        this._task = { state: "paused", pauseReason: "routine_step_denied" };
      } else if (recovered.blocked === "failed") {
        this._routineRun.blocked = "failed";
        this._task = { state: "paused", pauseReason: "routine_step_failed" };
      } else if (recovered.incomplete) {
        this._routineRun.incomplete = true;
        this._task = { state: "paused", pauseReason: "routine_recovery_incomplete" };
      }
    }
  }

  getGoal() {
    return this._goal;
  }

  // Read-only signal for harness profile selection (see
  // shared/harness-profile.js selectHarnessProfile); never itself grants or
  // changes execution authority.
  isRoutine() {
    return this._routineRun !== null;
  }

  getHarnessProfile() {
    return this._harnessProfile;
  }

  // Adaptive thinking (see planner-effort-policy.js adaptiveEffort): only when
  // the host runs effort mode "auto"; "fixed" always uses the configured effort.
  _effectivePlannerEffort(pendingMessages, url) {
    const revisit = typeof url === "string" && this._seenUrls.has(url);
    if (typeof url === "string") this._seenUrls.add(url);
    if (!this._adaptiveEffort) return this._plannerEffort;
    return adaptiveEffort({
      base: this._plannerEffort,
      lastActionType: this._lastActionType,
      lastActionOk: this._lastActionStatus === "ok",
      revisit,
      pendingMessages: Boolean(pendingMessages && pendingMessages.length > 0),
      easyStreak: this._easyStreak,
    });
  }

  setPolicySettings({ permissionMode, plannerEffort, paymentsEnabled } = {}) {
    const { PERMISSION_MODES } = require("./permission-policy");
    const allowedEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
    if (permissionMode !== undefined && !PERMISSION_MODES.includes(permissionMode)) throw new TaskControllerError("invalid_permission_mode", "permissionMode is invalid");
    if (plannerEffort !== undefined && !allowedEfforts.includes(plannerEffort)) throw new TaskControllerError("invalid_planner_effort", "plannerEffort is invalid");
    if (permissionMode !== undefined) this._permissionMode = permissionMode;
    if (plannerEffort !== undefined) this._plannerEffort = plannerEffort;
    if (paymentsEnabled !== undefined) {
      this._paymentsEnabled = paymentsEnabled === true;
      // Turning payments off takes effect now: a mandate already granted dies with it.
      if (!this._paymentsEnabled) for (const mandate of this._mandates) mandate.revoked = true;
    }
    this._browser.setPermissionMode?.(this._permissionMode);
  }

  getSnapshot() {
    this._pruneLeases();
    return {
      state: this._task.state,
      pauseReason: this._task.pauseReason,
      goalVersion: this._goal.goalVersion,
      budgets: { ...this._budgets },
      segment: { ...this._segment },
      criteriaStatus: [...this._criteriaStatus.entries()].map(([criterionId, v]) => ({ criterionId, ...v })),
      autoHandled: this._autoHandled,
      branches: this._branches ? this._branches.list() : [],
      approvalQueue: this._approvalQueue.map(({ id, summary, actionType, createdAt, descriptor, widen, leaseOffer }) => ({ id, summary, action: actionType, createdAt, target: descriptor?.target ?? null, widen: !!widen, leaseOffer: leaseOffer ?? null })),
      ...(this._task.pauseReason === "need_user" && this._needUserReason ? { needUserReason: this._needUserReason } : {}),
      leases: this._terminal()
        ? []
        : this._leases.filter((l) => isLeaseLive(l, this._monotonicNow())).map(({ id, action, origin, expiresAt, usesLeft }) => ({ id, action, origin, expiresAt, usesLeft })),
    };
  }

  _pruneLeases(now = this._monotonicNow()) {
    // Expired/consumed leases are already inert; retaining them forever makes
    // a long-running task's every gate scan grow with its entire history.
    // Keep only live leases and revocations whose durable journal append must
    // still be retried.
    this._leases = this._leases.filter((lease) =>
      (lease.revoked && !lease.revocationRecorded) || isLeaseLive(lease, now));
  }

  onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("onChange requires a listener function");
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _emit() {
    // A transition may have changed _task optimistically before its durable
    // checkpoint, or be draining a mutator. Publish only a settled snapshot.
    // Browser events use the host's last published snapshot for this reason.
    if (!this._admissionOpen || this._pendingTransitions > 0 || this._inFlightOps.size > 0 || this._pendingCheckpoints > 0 || !this._snapshotTrusted) return;
    const snapshot = this.getSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === this._lastEmittedSnapshot) return;
    this._lastEmittedSnapshot = serialized;
    for (const listener of this._listeners) {
      try {
        Promise.resolve(listener(structuredClone(snapshot))).catch(() => {});
      } catch {
        // Observers must never change the outcome of a committed operation.
      }
    }
  }

  getEvents(options) {
    return this._store.getEvents(options);
  }

  async recordHostNote(payload) {
    const autofill = contracts.isPlainObject(payload) && payload.kind === "credential_autofill_requested" &&
      typeof payload.credentialId === "string" && typeof payload.origin === "string";
    const sessions = contracts.isPlainObject(payload) && payload.kind === "imported_sessions_injected" &&
      Object.keys(payload).length === 4 && Number.isInteger(payload.injected) && payload.injected >= 0 &&
      Number.isInteger(payload.failed) && payload.failed >= 0 && Array.isArray(payload.domains) &&
      payload.domains.length <= 20 && payload.domains.every((domain) => typeof domain === "string" && domain.length <= 253);
    // Value-free by construction: exactly a fixed kind plus a short identifier-like code.
    const sessionFailure = contracts.isPlainObject(payload) && payload.kind === "imported_sessions_injection_failed" &&
      Object.keys(payload).length === 2 && typeof payload.errorCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(payload.errorCode);
    if (!autofill && !sessions && !sessionFailure) {
      throw new TaskControllerError("invalid_host_note", "unsupported host audit note");
    }
    await this._store.append({ type: "note", payload });
  }

  isUserControlled() {
    return this._admissionOpen && this._pendingTransitions === 0 && this._inFlightOps.size === 0 &&
      this._pendingCheckpoints === 0 && this._snapshotTrusted && this._task.pauseReason !== "memory_emergency" &&
      ["idle", "paused", "awaiting_verification", "completed", "stopped"].includes(this._task.state);
  }

  async userNavigate(action) {
    this._checkAdmission();
    if (!this.isUserControlled()) {
      throw new TaskControllerError("invalid_state", "take over the task before using its browser");
    }
    if (typeof this._browser.userNavigate !== "function") {
      throw new TaskControllerError("browser_unavailable", "this task browser does not support user navigation");
    }
    return this.runUserControlled(() => this._browser.userNavigate(action));
  }

  // Hold the same admission gate and transition drain for a complete trusted
  // human-only browser operation (for example vault decrypt + credential fill).
  // Otherwise resume() could hand the task back to the agent while an earlier
  // isUserControlled() check is still waiting on asynchronous host work.
  async runUserControlled(operation) {
    this._checkAdmission();
    if (typeof operation !== "function") {
      throw new TaskControllerError("invalid_operation", "a trusted user-controlled operation is required");
    }
    if (!this.isUserControlled()) {
      throw new TaskControllerError("invalid_state", "take over the task before using its browser");
    }
    this._admissionOpen = false;
    try {
      return await this._trackInFlight(Promise.resolve().then(operation));
    } finally {
      // A concurrent stop/takeover owns the gate until its drain finishes.
      if (this._pendingTransitions === 0) this._admissionOpen = true;
    }
  }

  _stopHappenedSince(epoch) {
    return epoch !== this._epoch;
  }

  _checkAdmission() {
    if (!this._admissionOpen) {
      throw new TaskControllerError("admission_closed", "a pause/stop/takeOver transition is in progress");
    }
  }

  // A failed _doTransition (a durable append/checkpoint error) can leave
  // _task.state already optimistically flipped to its target value -- the
  // same pre-existing pattern _pauseWith always used, state set before the
  // checkpoint await -- even though nothing was ever durably confirmed and
  // admission was correctly left closed (fail-closed). Nothing is currently
  // in flight in that case (_pendingTransitions is back to 0 once the
  // failure has fully unwound), so pause()/takeOver()'s normal
  // running/awaiting_approval guard would otherwise wedge them shut forever
  // with no way to retry. This condition identifies exactly that "stuck
  // from a prior failure, safe to retry" state and nothing else.
  _transitionRetryable() {
    return !this._admissionOpen && this._pendingTransitions === 0;
  }

  // FIFO for the three control-ownership transitions (pause/stop/takeOver):
  // a second concurrent call naturally runs after the first and finds
  // nothing left to do, rather than racing it. `fn` runs regardless of
  // whether the previous transition in the chain succeeded or threw (so one
  // failure can never wedge the queue), and the chain itself is re-caught so
  // it stays alive for the next enqueue. _pendingTransitions is incremented
  // synchronously here (before any await), which is what lets pause()/
  // stop()/takeOver() close admission and have that closure visible to a
  // synchronously-following approve() call, even though `fn` itself only
  // runs later once the chain reaches it.
  _enqueueTransition(fn) {
    this._pendingTransitions += 1;
    const run = this._transitionChain.then(fn, fn);
    this._transitionChain = run.catch(() => {});
    // .finally()'s own returned promise re-throws whatever `run` rejected
    // with; nothing else observes THIS particular derived promise (the
    // rejection itself is already surfaced to the real caller via the
    // `return run` below), so it needs its own no-op .catch() or Node
    // reports it as a second, spurious unhandledRejection.
    run.finally(() => {
      this._pendingTransitions -= 1;
    }).catch(() => {});
    return run;
  }

  // The actual transition body, run strictly one-at-a-time via
  // _enqueueTransition. Admission is ALREADY closed by the caller
  // (pause/stop/takeOver) before this was even enqueued -- this function
  // never opens or closes it except at its own tail. Order matters: cancel
  // still-queued approvals durably BEFORE removing them from memory (so a
  // failed append leaves the item retryable, never silently lost), THEN
  // drain every in-flight mutator so a transition can never checkpoint while
  // an admitted approve()/dispatch's true outcome is still undetermined,
  // THEN checkpoint the final state, and only reopen admission after that
  // checkpoint durably succeeds -- and only if this is the last transition
  // still pending (an earlier transition in a back-to-back burst must never
  // reopen the window a later, already-queued transition still needs
  // closed). Any append/checkpoint failure here propagates and leaves
  // admission closed (fail-closed) and _task unchanged, exactly like every
  // other store.append()/checkpoint() call in this file.
  async _doTransition({ finalState, pauseReason, cancelQueue, cancelReason }) {
    // A pending MCP review belongs to the agent's turn; any ownership change
    // (including a plain pause) withdraws it rather than leaving a human
    // approval that could dispatch after control changed hands.
    const queued = cancelQueue ? [...this._approvalQueue] : this._approvalQueue.filter(isMcpItem);
    if (queued.length > 0) {
      for (const item of queued) {
        // durable:false: this loop is always followed by this._checkpoint()
        // below (before any other await point reachable from here), and
        // checkpoint() itself flushes any pending non-durable bytes before
        // it commits -- so every approval_cancelled here is guaranteed
        // durable by the time this transition finishes, without paying for
        // its own fsync when there are several queued at once.
        await this._store.append({
          type: "approval_cancelled",
          payload: {
            requestId: item.id,
            actionType: item.actionType,
            goalVersion: item.goalVersion,
            reason: cancelReason ?? pauseReason ?? "pause",
          },
        }, { durable: false });
        const idx = this._approvalQueue.findIndex((q) => q.id === item.id);
        if (idx !== -1) this._approvalQueue.splice(idx, 1);
        if (isMcpItem(item)) item.mcp.settle({ allowed: false });
        this._branches?.resolve(item.id, "cancelled");
      }
    }
    if (finalState === "stopped") this._branches?.closeAll("stopped");
    // Stop and takeOver hand control back to the person: every lent
    // permission ends with them. Revoked before the drain so an in-flight
    // loop can no longer spend one (_useLease re-checks after its append).
    // A plain pause leaves leases to their own time box.
    if (cancelQueue) await this._revokeAllLeases(finalState === "stopped" ? "task_ended" : "taken_over");
    if (this._plannerShutdownRequired || this._planner.isTerminating?.()) {
      // Cancellation invalidates the proposal immediately, but control must
      // not reopen while its worker is still using the user's model account.
      // A shutdown failure leaves admission closed and this flag retryable.
      this._plannerShutdownRequired = true;
      await this._planner.close?.();
      this._plannerShutdownRequired = false;
    }
    await Promise.allSettled([...this._inFlightOps]);
    this._leaveActive();
    this._task = { state: finalState, pauseReason: finalState === "stopped" ? null : pauseReason };
    await this._checkpoint();
    if (this._pendingTransitions === 1) {
      // No other transition is still queued behind this one (the count
      // still includes this call itself -- it only decrements after this
      // function returns, in _enqueueTransition's .finally) -- safe to
      // reopen now that the checkpoint above durably landed.
      this._admissionOpen = true;
    }
  }

  // Register an already-started asynchronous operation before yielding to the
  // event loop. Transitions close admission synchronously, then drain this set
  // before checkpointing so an admitted write cannot land after ownership has
  // already been returned to the person.
  async _trackInFlight(op) {
    this._inFlightOps.add(op);
    try {
      return await op;
    } finally {
      this._inFlightOps.delete(op);
    }
  }

  // Keep the whole committed action lifecycle in the drain set: after
  // action_outcome, _afterActionDispatched may still append evidence and
  // checkpoint progress. A transition must wait for that tail too, not just
  // for browser.execute() to finish.
  async _dispatchApprovedAndApplyTracked(proposal, descriptor, action, epoch, { durable = true, widenedBy = null } = {}) {
    const op = (async () => {
      const result = await this._dispatchApproved(descriptor, action, epoch, { durable, widenedBy });
      if (this._stopHappenedSince(epoch)) return { stale: true, result };
      if (result.status === "uncertain") {
        await this._pauseWith("execution_uncertain");
        return { stale: false, result };
      }
      if (this._routineRunner && result.status !== "not_dispatched") {
        const binding = this._routineRunner.getCurrentStep?.();
        if (!binding) {
          await this._pauseWith("routine_cursor_mismatch");
          return { stale: false, result };
        }
        if (result.status === "ok") {
          // Inside a read-only batch only the last advancement is durable; its fsync also flushes the earlier ones.
          await this._store.append({ type: "routine_step_advanced", payload: { ...binding, actionId: result.actionId } }, { durable });
          // No per-step checkpoint: the durable advancement record above is the cursor's source of truth and
          // streamJournalReplay re-derives it after the last checkpoint; every pause/stop/finish checkpoints.
          this._routineRun.cursor = this._routineRunner.advance(binding);
        } else {
          await this._store.append({ type: "routine_step_failed", payload: {
            ...binding,
            actionId: result.actionId,
            status: result.status === "cancelled" ? "cancelled" : "failed",
            ...(typeof result.errorCode === "string" ? { errorCode: result.errorCode } : {}),
          } });
          await this._pauseWith("routine_step_failed");
          return { stale: false, result };
        }
      }
      await this._afterActionDispatched(proposal, result, epoch);
      return { stale: false, result };
    })();
    const result = await this._trackInFlight(op);
    this._emit();
    return result;
  }

  async _denyRoutineStep(decision) {
    const binding = this._routineRunner?.getCurrentStep?.();
    if (!binding || !this._routineRun) {
      await this._pauseWith("routine_cursor_mismatch");
      return;
    }
    const normalizedDecision = decision.decision === "quarantine" ? "quarantine" : "deny";
    const reasons = Array.isArray(decision.reasons)
      ? decision.reasons.filter((reason) => typeof reason === "string").slice(0, 16)
      : [];
    await this._store.append({ type: "routine_step_denied", payload: { ...binding, decision: normalizedDecision, reasons } });
    this._routineRun.blocked = "denied";
    await this._pauseWith("routine_step_denied");
  }

  // A rejected finish only makes sense when a machine can still verify the
  // missing criteria; a criterion that needs a human ("user") keeps today's
  // awaiting_verification handoff.
  _onlyHostVerifiable(missingIds) {
    return missingIds.length > 0 && missingIds.every((id) => this._goal.criteria.find((criterion) => criterion.id === id)?.verification === "host");
  }

  _goalPersistenceState() {
    const { missingIds } = canComplete(this._goal, this._evidenceForCompletionCheck());
    return { unmetCriterionIds: missingIds, rejectedFinishes: this._rejectedFinishes, maxRejectedFinishes: GOAL_MAX_REJECTED_FINISHES };
  }

  _recordNavigation(observation) {
    const nav = this._navigation;
    const url = typeof observation?.url === "string" ? observation.url.slice(0, NAV_URL_MAX_CHARS) : "";
    if (/^https?:\/\//i.test(url) && !nav.visited.includes(url)) {
      nav.visited.push(url);
      if (nav.visited.length > NAV_VISITED_MAX) nav.visited.splice(0, nav.visited.length - NAV_VISITED_MAX);
    }
    // A link seen now supersedes an older frontier entry for the same href.
    nav.frontier = nav.frontier.filter((entry) => !nav.visited.includes(entry.href));
    for (const element of Array.isArray(observation?.elements) ? observation.elements : []) {
      if (element?.role !== "link" || typeof element.href !== "string" || !/^https?:\/\//i.test(element.href)) continue;
      const href = element.href.slice(0, NAV_URL_MAX_CHARS);
      if (nav.visited.includes(href) || nav.frontier.some((entry) => entry.href === href)) continue;
      nav.frontier.push({ href, name: String(element.name ?? "").slice(0, NAV_NAME_MAX_CHARS) });
    }
    if (nav.frontier.length > NAV_FRONTIER_MAX) nav.frontier.splice(0, nav.frontier.length - NAV_FRONTIER_MAX);
  }

  _enterActive() {
    if (this._activeSince === null) this._activeSince = this._now();
  }

  _leaveActive() {
    if (this._activeSince !== null) {
      this._budgets.activeMs += this._now() - this._activeSince;
      this._activeSince = null;
    }
  }

  async _checkpoint() {
    this._pendingCheckpoints += 1;
    try {
      await this._store.checkpoint({
        task: { ...this._task },
        budgets: { ...this._budgets },
        segment: { ...this._segment },
        criteriaStatus: [...this._criteriaStatus.entries()],
        harnessProfile: this._harnessProfile,
        recoveryBudget: this._recovery.snapshot(),
        plannerEscalations: this._escalations,
        ...(this._harnessProfile === "long" ? { goalPersistence: { rejectedFinishes: this._rejectedFinishes } } : {}),
        ...(this._routineRun ? { routineRun: { ...this._routineRun } } : {}),
        ...(this._openMcpCalls.size > 0 ? { mcp: { openCalls: [...this._openMcpCalls] } } : {}),
      });
      this._snapshotTrusted = true;
    } catch (error) {
      this._snapshotTrusted = false;
      throw error;
    } finally {
      this._pendingCheckpoints -= 1;
    }
  }

  // Bounded self-recovery: a transient failure or a loop gets a couple of
  // automatic retries before the task pauses and asks the person. Never used
  // for waits that belong to the person (need_user, approvals, takeover).
  async _tryRecover(reason, step, detail) {
    const granted = this._recovery.tryConsume(reason);
    if (!granted) return reason === "planner_error" || reason === "no_progress" ? this._tryEscalate(reason) : false;
    // Retry only after its budget charge is durable. A crash before checkpoint
    // replays this complete bounded state from the validated journal tail.
    try {
      await this._store.append({ type: "note", payload: { kind: "recovery", reason, step, attempt: granted.attempt, total: granted.total,
        recoveryBudget: this._recovery.snapshot(), ...(detail ? { detail } : {}) } });
    } catch {
      return false; // No durable charge: take the caller's normal pause path.
    }
    return true;
  }

  async _tryEscalate(reason) {
    if (!this._escalatePlanner || this._escalations >= 1) return false;
    let next;
    try { next = await this._escalatePlanner({ reason }); } catch { return false; }
    if (!next || !next.planner || typeof next.planner.next !== "function") return false;
    try {
      await this._store.append({ type: "note", payload: { kind: "planner_escalation", reason, from: String(next.from ?? ""), to: String(next.to ?? "") } });
    } catch {
      await Promise.resolve(next.planner.close?.()).catch(() => {});
      return false;
    }
    const previous = this._planner;
    this._escalations += 1;
    this._planner = next.planner;
    this._plannerImageInput = next.imageInput !== false;
    this._recovery.noteProgress(); // New model gets a recent window, not a new lifetime.
    this._loopHint = false;
    await Promise.resolve(previous?.close?.()).catch(() => {});
    return true;
  }

  async _pauseWith(reason, detail) {
    this._leaveActive();
    this._finishFeedback = null;
    this._task = { state: "paused", pauseReason: reason };
    // Pause reasons otherwise live only in the latest checkpoint; keep each one
    // in the journal so "why does it keep pausing" can be answered afterwards.
    await this._store.append({ type: "note", payload: { kind: "paused", reason, ...(detail ? { detail } : {}) } }).catch(() => {});
    await this._checkpoint();
    this._emit();
  }

  // 900MB emergency pressure (user mandate, design doc section 10): tear
  // down this controller's OWNED resources -- its BrowserAdapter's
  // WebContentsView and its planner's worker child process -- rather than
  // merely pausing. dispose()/close() failing (e.g. the view was already
  // destroyed by something else) must never prevent the pause itself from
  // landing, so each is best-effort. Distinct pauseReason
  // ("memory_emergency") from the plain "memory_pressure" (800MB) pause so
  // resume() can refuse to reuse now-disposed resources instead of the
  // resume/reload storm the user explicitly prohibited -- recovering a
  // memory_emergency task requires a fresh TaskHost re-attachment (new
  // browser/planner instances), exactly like a process restart.
  async _pauseForMemoryEmergency() {
    this._leaveActive();
    this._task = { state: "paused", pauseReason: "memory_emergency" };
    await this._checkpoint();
    try {
      await this._browser.dispose?.();
    } catch {
      // best-effort -- see comment above
    }
    try {
      await this._planner.close?.();
    } catch {
      // best-effort -- see comment above
    }
    try {
      // Release the writer.lock so a fresh re-attachment (TaskHost's
      // resumeSavedTask(), or a real process restart) can actually
      // TaskStore.load() this task again -- without this, the abandoned
      // instance's still-held lock would make recovery impossible without
      // the whole host process exiting first.
      await this._store.close();
    } catch {
      // best-effort -- see comment above
    }
    this._emit();
  }

  // Awaiting the person's review needs no live page: keep the final URL and
  // title in the journal, then free both renderers so an unconfirmed task
  // stops costing memory. The store and planner stay for confirmCriterion().
  async _releaseViewsForReview() {
    try {
      const tab = this._browser.getBrowserSnapshot?.()?.tabs?.[0];
      await this._store.append({ type: "note", payload: { kind: "result_snapshot", url: tab?.url ?? null, title: tab?.title ?? null } }).catch(() => {});
      if (typeof this._browser.dispose === "function") {
        await this._browser.dispose();
        this._viewsReleased = true;
      }
    } catch {
      // best-effort -- the views are released again on terminal teardown
    }
  }

  // True once the review hand-off freed the views and a rejection also
  // closed the planner and store: only a fresh TaskHost re-attachment works.
  get needsReattach() { return this._needsReattach === true; }

  async _releaseForReattach() {
    this._needsReattach = true;
    try { await this._planner.close?.(); } catch { /* best-effort */ }
    try { await this._store.close(); } catch { /* best-effort */ }
  }

  async _pauseForMemoryPressure(pressure) {
    if (process.env.HALO_DEBUG_ACTIONS) {
      const sample = this._memoryMonitor.getLastSample?.();
      console.error("[memory-pause]", pressure, sample ? `${Math.round(sample.totalBytes / 1048576)}MB unmeasurable=${JSON.stringify(sample.unmeasurable)} by=${JSON.stringify(Object.entries((sample.byProcess ?? []).reduce((acc, p) => { acc[p.label] = (acc[p.label] ?? 0) + (p.bytes ?? 0); return acc; }, {})).map(([k, v]) => `${k}:${Math.round(v / 1048576)}MB`))} n=${(sample.byProcess ?? []).length}` : "no sample");
    }
    if (pressure === "emergency") {
      await this._pauseForMemoryEmergency();
    } else {
      await this._pauseWith("memory_pressure");
    }
  }

  async start() {
    if (this._task.state !== "idle") {
      throw new TaskControllerError("invalid_state", `start() requires state idle, got ${this._task.state}`);
    }
    this._task = { state: "running", pauseReason: null };
    this._emit();
    return this._runLoop();
  }

  async resume(opts = {}) {
    this._checkAdmission();
    if (this._task.state !== "paused") {
      throw new TaskControllerError("invalid_state", `resume() requires state paused, got ${this._task.state}`);
    }
    if (this._routineRunner && (this._routineRun?.blocked || this._routineRun?.incomplete || this._store.recoveryReason === "execution_uncertain")) {
      throw new TaskControllerError("routine_recovery_incomplete", "a denied, failed, or uncertain routine step cannot be replayed; stop or inspect the task instead");
    }
    if ((this._task.pauseReason === "execution_uncertain" || this._openMcpCalls.size > 0) && !opts.confirmed) {
      throw new TaskControllerError(
        "confirmation_required",
        "resume() from execution_uncertain requires resume({confirmed: true}) -- the dangling action is never auto-replayed",
      );
    }
    if (this._task.pauseReason === "memory_emergency" || this._needsReattach) {
      // This controller's own browser/planner were already disposed when
      // emergency pressure hit -- there is nothing left here to resume into,
      // and no confirmed:true can rescue that (unlike execution_uncertain,
      // resuming THIS controller is not an option at all, not just gated).
      // Recovery requires a fresh TaskHost re-attachment (new browser/
      // planner instances), exactly like a process restart.
      throw new TaskControllerError(
        "resources_disposed",
        "this controller's browser/planner were disposed after a memory emergency -- re-attach the task fresh instead of resuming this instance",
      );
    }
    if (this._openMcpCalls.size > 0) {
      // The person confirmed the uncertain MCP call(s); close them durably so
      // a restart does not re-report them. Nothing is ever replayed.
      const epoch = this._epoch;
      await this._trackInFlight(this._acknowledgeOpenMcpCalls());
      if (this._stopHappenedSince(epoch) || this._task.state !== "paused") return this.getSnapshot();
    }
    this._task = { state: "running", pauseReason: null };
    // Any interruption's cursor is meaningless now -- resume always starts
    // the next iteration with a completely fresh observation (design doc
    // section 7: "resume은 새 observation부터 시작한다. 이미 끝난 action은
    // 재생하지 않는다"). Phase 2 Task 4's reuse cache must never survive a
    // resume either, for the same reason.
    this._lastObservation = null;
    this._reusableObservation = null;
    this._rejectedProposals = 0; // Explicit user resume, never an automatic retry.
    this._emit();
    return this._runLoop();
  }

  async pause(reason = "user") {
    if (!["running", "awaiting_approval"].includes(this._task.state) && !this._transitionRetryable() && !this._planner.isTerminating?.()) {
      return this.getSnapshot();
    }
    // Close admission and invalidate any in-flight planner/approver
    // round-trip SYNCHRONOUSLY, before _enqueueTransition ever schedules
    // _doTransition -- _enqueueTransition chains via Promise.then, which
    // only runs on a later microtask, so a synchronously-following approve()
    // call must see the closed gate right here, not after that microtask.
    this._admissionOpen = false;
    this._epoch += 1;
    this._cancelPlanner();
    await this._enqueueTransition(() =>
      this._doTransition({ finalState: "paused", pauseReason: reason, cancelQueue: false, cancelReason: null }),
    );
    this._emit();
    return this.getSnapshot();
  }

  async stop() {
    // No state guard, matching stop()'s pre-existing behavior: it always
    // forces a transition to stopped regardless of current state.
    this._admissionOpen = false;
    this._epoch += 1;
    this._cancelPlanner();
    await this._enqueueTransition(() =>
      this._doTransition({ finalState: "stopped", pauseReason: null, cancelQueue: true, cancelReason: "stop" }),
    );
    this._emit();
    return this.getSnapshot();
  }

  // Trusted-IPC-only (task-host.js/ipc.js gate this like every other
  // HARNESS_METHODS channel): a human takes control back from the agent.
  // Cancels any still-queued approval requests with a durable
  // approval_cancelled audit record (never silently drops one), and -- via
  // the shared admission gate/drain in _doTransition -- waits for any
  // already-admitted approve()/dispatch to reach its TRUE outcome first,
  // rather than labeling something "cancelled" that already ran.
  async takeOver(reason = "user_takeover") {
    if (!["running", "awaiting_approval"].includes(this._task.state) && !this._transitionRetryable() && !this._planner.isTerminating?.()) {
      return this.getSnapshot();
    }
    this._admissionOpen = false;
    this._epoch += 1;
    this._cancelPlanner();
    await this._enqueueTransition(() =>
      this._doTransition({ finalState: "paused", pauseReason: reason, cancelQueue: true, cancelReason: reason }),
    );
    this._emit();
    return this.getSnapshot();
  }

  async amend(amendmentInput) {
    this._checkAdmission();
    const goal = await this._trackInFlight(this._amend(amendmentInput));
    this._emit();
    return goal;
  }

  async _amend(amendmentInput) {
    if (["stopped", "completed"].includes(this._task.state)) {
      throw new TaskControllerError("invalid_state", `cannot amend a task in state ${this._task.state}`);
    }
    const nextGoal = await this._store.amendGoal(amendmentInput);
    this._goal = nextGoal;
    this._browser.setIntentLock?.(nextGoal.lock ?? null);
    this._browser.setPrivateNetworkAllowance?.(this._personNamedPrivateOrigins());
    // The intent changed, so every lent permission is taken back.
    await this._revokeAllLeases("goal_amended", { durable: true });
    // A goal amendment invalidates any stale in-flight proposal/approval
    // tied to the old goalVersion (design doc section 7).
    this._epoch += 1;
    await this._cancelMcpReviews("goal_amended");
    await this._checkpoint();
    return nextGoal;
  }

  // Task 5: the trusted-IPC-only path (main/ipc.js gates the caller with
  // trusted-sender.js) that lets a human satisfy a "user"-verification
  // criterion. progress.js's verifyCriterion() only ever honors a
  // PRE-EXISTING verified/rejected evidence entry for a "user"-kind
  // criterion -- nothing in the planner/browser loop can set that itself.
  // Rejects a stale goalVersion or an evidenceId that doesn't match the
  // currently pending one, so a confirmation the UI queued against an old
  // amendment or an old pending item can never be silently applied to
  // whatever is current now.
  async confirmCriterion({ criterionId, goalVersion, evidenceId, outcome } = {}) {
    this._checkAdmission();
    const snapshot = await this._trackInFlight(this._confirmCriterion({ criterionId, goalVersion, evidenceId, outcome }));
    this._emit();
    return snapshot;
  }

  async _confirmCriterion({ criterionId, goalVersion, evidenceId, outcome } = {}) {
    if (this._task.state === "stopped") {
      throw new TaskControllerError("invalid_state", "cannot confirm a criterion on a stopped task");
    }
    if (outcome !== "verified" && outcome !== "rejected") {
      throw new TaskControllerError("invalid_field", "outcome must be 'verified' or 'rejected'");
    }
    if (goalVersion !== this._goal.goalVersion) {
      throw new TaskControllerError(
        "stale_goal_version",
        `confirmCriterion targets goalVersion ${goalVersion}, current is ${this._goal.goalVersion}`,
      );
    }
    const criterion = this._goal.criteria.find((c) => c.id === criterionId);
    if (!criterion) {
      throw new TaskControllerError("unknown_criterion", `unknown criterionId ${criterionId}`);
    }
    const current = this._criteriaStatus.get(criterionId);
    if (!current || current.goalVersion !== goalVersion || current.evidenceId !== evidenceId) {
      throw new TaskControllerError(
        "stale_evidence",
        `no pending evidence ${evidenceId} for criterion ${criterionId} at goalVersion ${goalVersion}`,
      );
    }

    const confirmed = {
      id: randomUUID(),
      taskId: this._goal.taskId,
      goalVersion,
      criterionId,
      kind: "user_confirmation",
      at: new Date(this._now()).toISOString(),
      verification: outcome,
      verifierId: "user",
      details: { confirmsEvidenceId: evidenceId },
    };
    await this._store.append({ type: "evidence_recorded", payload: { evidence: confirmed } });
    this._criteriaStatus.set(criterionId, { status: outcome, evidenceId: confirmed.id, goalVersion });

    if (this._task.state === "awaiting_verification") {
      if (outcome === "verified") {
        const completion = canComplete(this._goal, this._evidenceForCompletionCheck());
        if (completion.complete) {
          this._task = { state: "completed", pauseReason: null };
          await this._revokeAllLeases("task_ended");
          await this._checkpoint();
        }
      } else {
        // A rejected criterion cannot complete the task as-is, but leaving
        // the task stuck in awaiting_verification forever gives the user no
        // durable path back to replanning. Fail closed into a state Resume
        // already accepts, with a pauseReason that names why.
        this._task = { state: "paused", pauseReason: "evidence_rejected" };
        await this._checkpoint();
        // Views were released at the review hand-off; resume() cannot reuse
        // them, so recover through a fresh re-attachment like an emergency.
        if (this._viewsReleased) await this._releaseForReattach();
      }
    }
    return this.getSnapshot();
  }

  async approve(requestId) {
    this._checkAdmission();
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    const [item] = this._approvalQueue.splice(index, 1);
    if (isMcpItem(item)) return this._approveMcp(item);
    const stale = this._stopHappenedSince(item.epoch) || this._monotonicNow() >= item.deadline;
    this._branches?.resolve(item.id, stale ? "expired" : "approved");
    const wasAwaitingApproval = !this._approvalQueue.some((q) => !isMcpItem(q)) && this._task.state === "awaiting_approval";
    if (wasAwaitingApproval) {
      this._task = { state: "running", pauseReason: null };
    }
    // Approval-binding staleness check (design doc section 7): pause/stop/
    // amend all bump the epoch, and every binding expires after 60s
    // regardless. A stale item was never re-validated against the current
    // goal/epoch, so it must be dropped -- exactly like a deny() -- rather
    // than dispatched against a goal or execution context it no longer
    // corresponds to.
    if (this._stopHappenedSince(item.epoch) || this._monotonicNow() >= item.deadline) {
      this._emit();
      if (wasAwaitingApproval) return this._runLoop();
      return this.getSnapshot();
    }
    this._enterActive();
    const epoch = this._epoch;
    if (item.actions) {
      const outcome = await this._runApprovedReadOnlyBatch(item.proposal, item.actions, epoch);
      if (outcome === "stop_loop" || this._stopHappenedSince(epoch)) return this.getSnapshot();
    } else {
      // The user clicked for this very request, so a widened item runs once
      // even if the lease they just lent were somehow no longer live.
      const leased = item.useLease ? await this._useLease(this._leases.find((l) => l.id === item.useLease), item.id) : null;
      // The grant names the origin the user saw, so the browser refuses to
      // land anywhere else (a re-resolved link or a redirect).
      const widenedBy = leased ?? (item.widen ? { kind: "user_once", ...(item.targetOrigin ? { origin: item.targetOrigin } : {}) } : null);
      const dispatched = await this._dispatchApprovedAndApplyTracked(item.proposal, item.descriptor, item.action, epoch, { widenedBy });
      if (dispatched.stale || this._stopHappenedSince(epoch)) return this.getSnapshot();
    }
    if (this._task.state === "running") return this._runLoop();
    return this.getSnapshot();
  }

  async deny(requestId) {
    this._checkAdmission();
    const index = this._approvalQueue.findIndex((item) => item.id === requestId);
    if (index === -1) return this.getSnapshot();
    // Nothing was ever dispatched for a queued-but-denied item (no
    // action_started was written for it -- see _dispatchActionsBatch), so
    // there is no action lifecycle event to close out here, only the queue
    // entry to drop.
    const [item] = this._approvalQueue.splice(index, 1);
    this._branches?.resolve(item.id, "rejected");
    if (isMcpItem(item)) {
      item.mcp.settle({ allowed: false });
      this._emit();
      return this.getSnapshot();
    }
    if (!this._approvalQueue.some((q) => !isMcpItem(q)) && this._task.state === "awaiting_approval") {
      this._task = { state: "running", pauseReason: null };
      this._emit();
      return this._runLoop();
    }
    this._emit();
    return this.getSnapshot();
  }

  // Lend: the user turns one queued request into a short, scoped lease. The
  // request itself is approved and counts as the lease's first use.
  async lend(requestId, terms) {
    this._checkAdmission();
    // Keep the whole user operation admitted, not only lease_granted. If a
    // transition closes admission between the durable grant and the request's
    // final disposition, its request_stale revocation must also land before
    // the transition checkpoints or closes the TaskStore.
    return this._trackInFlight(this._lend(requestId, terms));
  }

  async _lend(requestId, terms) {
    const item = this._approvalQueue.find((q) => q.id === requestId);
    // One lease per request: a second, concurrent lend finds it taken.
    if (!item || isMcpItem(item) || item.actions || !item.leaseOffer || item.lending || item.useLease) {
      throw new TaskControllerError("lease_unavailable", "this request cannot be lent as a lease");
    }
    let parsed;
    try {
      if (terms !== null && terms !== undefined && !contracts.isPlainObject(terms)) {
        throw new LeaseError("invalid_lease_terms", "lease terms must be an object");
      }
      parsed = lendTerms(terms ?? undefined);
    } catch (error) {
      if (error instanceof LeaseError) throw new TaskControllerError(error.code, error.message);
      throw new TaskControllerError("invalid_lease_terms", "lease terms are invalid");
    }
    const fresh = () => !this._stopHappenedSince(item.epoch) && this._monotonicNow() < item.deadline;
    // A stale item is dropped by approve(); it never earns a lease.
    if (!fresh()) return this.approve(requestId);
    item.lending = true;
    const lease = createLease({
      id: randomUUID(),
      taskId: this._goal.taskId,
      action: item.leaseOffer.action,
      origin: item.leaseOffer.origin,
      now: this._monotonicNow(),
      wallNow: this._now(),
      ...parsed,
    });
    try {
      // Tracked so a concurrent transition drains the grant before it checkpoints.
      await this._trackInFlight(this._store.append({ type: "lease_granted", payload: { leaseId: lease.id, action: lease.action, origin: lease.origin, expiresAt: lease.expiresAt, uses: parsed.uses } }));
    } catch (error) {
      item.lending = false;
      throw error;
    }
    this._leases.push(lease);
    // Anything may have happened while the grant was written: a pause/stop,
    // the request expiring or leaving the queue. Then the lease goes too.
    if (!this._admissionOpen || !fresh() || !this._approvalQueue.includes(item)) {
      await this._revokeLeaseQuietly(lease, "request_stale");
      if (!this._admissionOpen) throw new TaskControllerError("admission_closed", "a pause/stop/takeOver transition is in progress");
      if (!this._approvalQueue.includes(item)) return this.getSnapshot();
      return this.approve(requestId);
    }
    item.useLease = lease.id;
    try {
      return await this.approve(requestId);
    } catch (error) {
      await this._revokeLeaseQuietly(lease, "request_stale");
      throw error;
    }
  }

  async revokeLease(leaseId) {
    const lease = this._leases.find((l) => l.id === leaseId);
    if (lease && (!lease.revoked || !lease.revocationRecorded)) {
      // A user revocation is a durable write just like a lease grant/use.
      // Register it before yielding so a concurrent stop/takeOver/amend drains
      // the record before its terminal checkpoint or storage teardown.
      await this._trackInFlight(this._revokeLease(lease, "user"));
      this._emit();
    }
    return this.getSnapshot();
  }

  // Marked revoked in memory first, so nothing can spend it while the
  // record is written.
  async _revokeLease(lease, reason, { durable = true } = {}) {
    if (lease.revocationRecorded) return;
    if (lease.revocationPromise) return lease.revocationPromise;
    lease.revoked = true;
    const append = this._store.append({ type: "lease_revoked", payload: { leaseId: lease.id, reason } }, { durable })
      .then(() => { lease.revocationRecorded = true; });
    lease.revocationPromise = append;
    try {
      await append;
    } finally {
      if (lease.revocationPromise === append) lease.revocationPromise = null;
    }
  }

  // Cleanup path for a failure already being reported: the lease is dead in
  // memory either way; a failed record must not mask the original error.
  async _revokeLeaseQuietly(lease, reason) {
    try {
      await this._revokeLease(lease, reason);
    } catch {
      lease.revoked = true;
    }
  }

  // durable:false by default: callers checkpoint right after, which flushes it.
  async _revokeAllLeases(reason, { durable = false } = {}) {
    for (const lease of this._leases.filter((l) => isLeaseLive(l, this._monotonicNow()) || (l.revoked && !l.revocationRecorded))) {
      await this._revokeLease(lease, reason, { durable });
    }
  }

  // The use is reserved synchronously (so two concurrent callers cannot both
  // spend the last one) and journaled durably BEFORE the action runs: a crash
  // mid-action can never hand the use back. A lease revoked while the record
  // was written runs nothing; its use stays spent (fail closed). A dead lease
  // returns null and runs nothing.
  async _useLease(lease, requestId) {
    if (!lease || !isLeaseLive(lease, this._monotonicNow())) return null;
    lease.usesLeft -= 1;
    await this._store.append({ type: "lease_used", payload: { leaseId: lease.id, requestId } });
    // The reservation remains spent, but a lease that expired while its
    // durable use record was being written no longer authorizes dispatch.
    if (lease.revoked || this._monotonicNow() >= lease.deadline) return null;
    return { kind: "lease", leaseId: lease.id, origin: lease.origin };
  }

  // --- generic MCP (host-scoped; see docs/superpowers/specs/2026-09-30-generic-mcp-broker-design.md) ---
  //
  // Trusted-host-only surface. The model/renderer never receives the broker,
  // an approval, or a way to call requestApproval: every call is proposed
  // here, queued in the ordinary approval queue for a human (regardless of
  // the browser permission mode), bound to this task's epoch/goal, and
  // dispatched once through the drain set so transitions wait for its real
  // outcome.

  _terminal() {
    return ["stopped", "completed"].includes(this._task.state);
  }

  _requireMcp() {
    if (!this._makeMcpBroker || this._mcpClosed) {
      throw new TaskControllerError("mcp_disabled", "MCP is not enabled for this task");
    }
    if (!this._mcpBroker) {
      this._mcpBroker = this._makeMcpBroker({
        getContext: () => ({ taskId: this._store.taskId, goalVersion: this._goal.goalVersion, epoch: this._epoch }),
        requestApproval: (request) => this._requestMcpApproval(request),
        journal: { append: (event) => this._appendMcpJournal(event) },
      });
      if (!this._mcpBroker || typeof this._mcpBroker.proposeCall !== "function") {
        this._mcpBroker = null;
        throw new TaskControllerError("mcp_disabled", "MCP broker factory returned no broker");
      }
    }
    return this._mcpBroker;
  }

  async listMcpConnections() {
    return this._requireMcp().listConnections();
  }

  async searchMcpTools(query) {
    return this._requireMcp().searchTools(query);
  }

  async describeMcpTool(connectionId, toolName) {
    return this._requireMcp().describeTool(connectionId, toolName);
  }

  // Trusted UI only: the full review (including arguments) a person needs to
  // decide. The renderer-facing snapshot carries only id/action/target.
  describeMcpApproval(requestId) {
    const item = this._approvalQueue.find((q) => q.id === requestId && isMcpItem(q));
    if (!item) throw new TaskControllerError("unknown_request", "no pending MCP review with that id");
    return structuredClone(item.mcp.review);
  }

  async proposeMcpCall(request, { reason } = {}) {
    let proposal;
    try {
      proposal = contracts.validateMcpProposal(request);
    } catch (error) {
      throw new TaskControllerError("invalid_mcp_proposal", error.message);
    }
    const broker = this._requireMcp();
    this._checkAdmission();
    if (this._terminal()) {
      throw new TaskControllerError("invalid_state", `cannot call MCP tools in state ${this._task.state}`);
    }
    const token = { epoch: this._epoch, goalVersion: this._goal.goalVersion, item: null, approvalId: null, release: null,
      reason: typeof reason === "string" ? reason.slice(0, 2000) : null };
    try {
      const approval = await this._mcpContext.run(token, () => broker.proposeCall(proposal));
      // approve() admitted this under the then-current epoch; a transition or
      // amendment since then (which drains token.release) wins.
      if (this._stopHappenedSince(token.epoch) || this._goal.goalVersion !== token.goalVersion || this._terminal()) {
        throw new TaskControllerError("stale_proposal", "the task changed after this MCP call was approved");
      }
      token.approvalId = approval.id;
      try {
        return await this._mcpContext.run(token, () => broker.dispatchApproved(approval.id));
      } catch (error) {
        if (error?.code === "execution_uncertain") {
          if (!this._terminal() && !this._stopHappenedSince(token.epoch)) await this._pauseWith("execution_uncertain");
        } else if (this._openMcpCalls.has(approval.id)) {
          // The durable preclaim landed but the broker refused before calling.
          await this._closeMcpCall(approval.id, "not_dispatched").catch(() => {});
        }
        throw error;
      }
    } finally {
      token.release?.();
    }
  }

  async closeMcp() {
    this._mcpClosed = true;
    this._plannerMcpEnabled = false;
    for (const item of this._approvalQueue.filter(isMcpItem)) {
      const idx = this._approvalQueue.indexOf(item);
      if (idx !== -1) this._approvalQueue.splice(idx, 1);
      item.mcp.settle({ allowed: false });
    }
    const broker = this._mcpBroker;
    this._mcpBroker = null;
    this._emit();
    if (broker) await broker.close();
  }

  async _applyReviewFallback(decision, actionType) {
    if (decision.decision !== "review" || this._reviewFallback !== "deny") return decision;
    const reasons = Array.isArray(decision.reasons) ? [...decision.reasons] : [];
    await this._store.append({ type: "note", payload: { kind: "review_auto_denied", actionType, reasons } });
    return { decision: "deny", reasons: [...reasons, "unattended_auto_deny"] };
  }

  // When the page changes, the page just left is kept as a text-only
  // snapshot ref (url, title, text; no element ids, so nothing in it can be
  // acted on). A revisited URL replaces its older snapshot. Returns the manifest.
  _refreshContextRefs() {
    if (!this._contextRefs) this._contextRefs = new ContextRefCatalog({ taskId: this._goal.taskId });
    const current = this._lastObservation;
    const previous = this._contextRefsPage;
    if (previous && current && (previous.url !== current.url || previous.documentEpoch !== current.documentEpoch)) {
      const url = typeof previous.url === "string" ? previous.url : "";
      const prior = this._pageRefs.get(url);
      if (prior) this._contextRefs.revoke(prior);
      try {
        const refId = this._contextRefs.register({
          kind: "observation",
          authority: "untrusted_page_derived",
          body: { url, title: typeof previous.title === "string" ? previous.title : "", text: typeof previous.text === "string" ? previous.text : "" },
          summary: `Earlier page: ${url}`,
          goalVersion: this._goal.goalVersion,
        });
        this._pageRefs.delete(url);
        this._pageRefs.set(url, refId);
        while (this._pageRefs.size > 128) this._pageRefs.delete(this._pageRefs.keys().next().value);
      } catch {
        // An oversized or unserializable page is simply not offered.
      }
    }
    if (current) this._contextRefsPage = current;
    return this._contextRefs.manifest();
  }

  _mcpAvailableToPlanner() {
    return this._plannerMcpEnabled && !this._mcpClosed;
  }

  async _handlePlannerMcpAction(action, epoch) {
    const kind = mcpActionKind(action);
    const active = () => this._task.state === "running" && !this._stopHappenedSince(epoch);
    try {
      let value;
      if (kind === "search") {
        value = await this.searchMcpTools(action.query);
      } else if (kind === "describe") {
        value = await this.describeMcpTool(action.connectionId, action.toolName);
      } else {
        try {
          value = await this.proposeMcpCall(
            { connectionId: action.connectionId, toolName: action.toolName, arguments: action.arguments },
            { reason: action.reason },
          );
        } catch (error) {
          if (error?.code === "execution_uncertain") {
            this._pendingMcpObservation = boundedMcpObservation(kind, "execution_uncertain", "", { code: "execution_uncertain" });
            return this._pendingMcpObservation;
          }
          if (error?.code === "approval_denied") return boundedMcpObservation(kind, "denied", "", { code: "approval_denied" });
          throw error;
        }
      }
      if (!active()) return null;
      const serialized = JSON.stringify(value);
      return boundedMcpObservation(kind, "ok", serialized);
    } catch (error) {
      if (error?.code === "mcp_disabled") return boundedMcpObservation(kind, "unavailable", "", { code: "mcp_disabled" });
      if (error?.code === "approval_denied") return boundedMcpObservation(kind, "denied", "", { code: "approval_denied" });
      if (error?.code === "execution_uncertain") return boundedMcpObservation(kind, "execution_uncertain", "", { code: "execution_uncertain" });
      return boundedMcpObservation(kind, "error", "", { code: typeof error?.code === "string" ? error.code.slice(0, 64) : "mcp_error" });
    }
  }

  // Broker callback. Only a review requested from inside proposeMcpCall()
  // (correlated through AsyncLocalStorage) can ever be queued; anything else
  // is refused, so no other caller can mint a human approval.
  _requestMcpApproval(request) {
    const token = this._mcpContext.getStore();
    if (!token || token.item || !contracts.isPlainObject(request) || request.signal?.aborted ||
        this._stopHappenedSince(token.epoch) || this._goal.goalVersion !== token.goalVersion ||
        !this._admissionOpen || this._terminal()) {
      return { allowed: false };
    }
    const { signal } = request;
    const target = `${String(request.server).slice(0, 64)}/${String(request.toolName).slice(0, 128)}`;
    const createdAt = this._now();
    const deadline = this._monotonicNow() + contracts.APPROVAL_EXPIRY_MS;
    return new Promise((resolve) => {
      let settled = false;
      const onAbort = () => {
        const idx = this._approvalQueue.indexOf(item);
        if (idx !== -1) this._approvalQueue.splice(idx, 1);
        settle({ allowed: false });
        this._emit();
      };
      const settle = (decision) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        resolve(decision);
      };
      const item = {
        id: randomUUID(),
        summary: `MCP ${target}${token.reason ? ` — ${token.reason}` : ""}`.slice(0, 2100),
        actionType: contracts.MCP_CALL_ACTION_TYPE,
        createdAt,
        epoch: token.epoch,
        goalVersion: token.goalVersion,
        expiresAt: createdAt + contracts.APPROVAL_EXPIRY_MS,
        deadline,
        descriptor: { target },
        mcp: {
          token,
          settle,
          review: {
            connectionId: request.connectionId,
            provider: request.provider,
            server: request.server,
            toolName: request.toolName,
            reason: token.reason,
            connectorId: request.connectorId ?? null,
            generation: request.generation,
            arguments: structuredClone(request.arguments),
            risk: request.risk,
            authority: "untrusted_connector",
          },
        },
      };
      item.mcp.review.id = item.id;
      item.mcp.review.expiresAt = item.expiresAt;
      token.item = item;
      signal?.addEventListener?.("abort", onAbort, { once: true });
      this._approvalQueue.push(item);
      this._emit();
    });
  }

  async _approveMcp(item) {
    const { settle, token } = item.mcp;
    if (this._stopHappenedSince(item.epoch) || this._monotonicNow() >= item.deadline ||
        item.goalVersion !== this._goal.goalVersion || this._terminal()) {
      settle({ allowed: false });
      this._emit();
      return this.getSnapshot();
    }
    // Register the dispatch in the drain set before the proposal continues,
    // so a transition started after this point waits for its real outcome.
    const done = new Promise((resolve) => { token.release = resolve; });
    const tracked = this._trackInFlight(done);
    settle({ allowed: true, kind: "human" });
    await tracked;
    this._emit();
    return this.getSnapshot();
  }

  async _cancelMcpReviews(reason) {
    for (const item of this._approvalQueue.filter(isMcpItem)) {
      await this._store.append({
        type: "approval_cancelled",
        payload: { requestId: item.id, actionType: item.actionType, goalVersion: item.goalVersion, reason },
      }, { durable: false });
      const idx = this._approvalQueue.indexOf(item);
      if (idx !== -1) this._approvalQueue.splice(idx, 1);
      item.mcp.settle({ allowed: false });
    }
  }

  // Broker journal adapter: translate to value-free durable notes (no
  // arguments, no raw result). A failed preclaim append makes the broker
  // refuse the call (journal_failed) before any provider is contacted.
  async _appendMcpJournal(event) {
    const token = this._mcpContext.getStore();
    if (!contracts.isPlainObject(event) || !token || token.approvalId !== event.requestId) {
      throw new TaskControllerError("invalid_mcp_journal_event", "MCP journal event outside an approved dispatch");
    }
    let payload;
    if (event.type === "mcp_call_started" && contracts.isPlainObject(event.binding)) {
      const b = event.binding;
      payload = {
        kind: "mcp_call_started", requestId: event.requestId, connectionId: b.connectionId, provider: b.provider,
        server: b.server, generation: b.generation, toolName: b.toolName, connectorId: b.connectorId ?? null,
        schemaDigest: b.schemaDigest, argsDigest: b.argsDigest, contextDigest: b.contextDigest,
      };
    } else if (event.type === "mcp_call_outcome" && ["ok", "tool_error"].includes(event.outcome) && this._openMcpCalls.has(event.requestId)) {
      payload = { kind: "mcp_call_outcome", requestId: event.requestId, outcome: event.outcome, resultDigest: event.resultDigest };
    } else {
      throw new TaskControllerError("invalid_mcp_journal_event", "unsupported MCP journal event");
    }
    try {
      contracts.validateMcpCallNote(payload, "mcpNote");
    } catch (error) {
      throw new TaskControllerError("invalid_mcp_journal_event", error.message);
    }
    await this._store.append({ type: "note", payload });
    if (payload.kind === "mcp_call_started") this._openMcpCalls.add(payload.requestId);
    else this._openMcpCalls.delete(payload.requestId);
  }

  async _closeMcpCall(requestId, outcome) {
    await this._store.append({ type: "note", payload: { kind: "mcp_call_outcome", requestId, outcome, resultDigest: null } });
    this._openMcpCalls.delete(requestId);
  }

  async _acknowledgeOpenMcpCalls() {
    for (const requestId of [...this._openMcpCalls]) await this._closeMcpCall(requestId, "uncertain_acknowledged");
  }

  // --- internal loop ---

  _cancelPlanner() {
    if (!this._plannerAborter) return;
    this._plannerShutdownRequired = true;
    this._plannerAborter.abort();
  }

  async _nextPlanner(context, plannerOptions = {}) {
    const aborter = new AbortController();
    this._plannerAborter = aborter;
    let onAbort;
    const cancelled = new Promise((resolve, reject) => {
      onAbort = () => reject(new TaskControllerError("aborted", "planner turn was cancelled"));
      aborter.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      // Fence non-cooperative injected planners too. Their late result has
      // no execution authority; close() owns actual worker termination.
      return await Promise.race([this._planner.next(context, { ...plannerOptions, signal: aborter.signal }), cancelled]);
    } finally {
      aborter.signal.removeEventListener("abort", onAbort);
      if (this._plannerAborter === aborter) this._plannerAborter = null;
    }
  }

  async _runLoop() {
    if (this._loopRunning) return this.getSnapshot();
    this._loopRunning = true;
    try {
      if (this._harnessProfile === "long" && this._rejectedFinishes >= GOAL_MAX_REJECTED_FINISHES) {
        await this._pauseWith("goal_not_reached");
        return this.getSnapshot();
      }
      // Planner process startup is independent of the first page observation.
      // Start it now so its cold launch can overlap with that browser work;
      // no request is sent until the normal observe -> plan boundary below.
      if (typeof this._planner.warm === "function") {
        try {
          this._planner.warm();
        } catch {
          // Keep the established planner_error handling at next(); a warm-up
          // failure is not itself a model response or an execution decision.
        }
      }
      while (this._task.state === "running") {
        const epoch = this._epoch;
        this._enterActive();

        // An unclear payment order is asked about before any planning happens.
        if (await this._ensureMandate() === "stop_loop") break;

        const pressure = this._memoryMonitor.getPressureLevel();
        if (pressure === "pause" || pressure === "emergency") {
          await this._pauseForMemoryPressure(pressure);
          break;
        }

        const activeMs = this._budgets.activeMs + (this._activeSince !== null ? this._now() - this._activeSince : 0);
        if (this._budgets.plannerCallsUsed >= this._goal.limits.maxPlannerCalls || activeMs >= this._goal.limits.maxActiveMs) {
          await this._pauseWith("budget_exhausted");
          break;
        }

        let observation;
        // short only: reuse the last dispatched action's own observation
        // instead of unconditionally re-observing, but only when
        // getDocumentEpoch() -- the same authority execute()'s own
        // stale_document guard trusts -- proves nothing has navigated since.
        // No match (including a fake with no getDocumentEpoch()) means a
        // real re-observe, same as middle/long always do.
        const reusable = isQuickProfile(this._harnessProfile) ? this._reusableObservation : null;
        if (reusable && typeof this._browser.getDocumentEpoch === "function" &&
            this._browser.getDocumentEpoch() === reusable.documentEpoch) {
          observation = reusable;
        } else {
          // A page that is still navigating (a click that redirects, a late
          // client-side route) fails observe() with stale_document. That is
          // not a broken page: wait briefly and observe the settled one. Any
          // other failure, or a page that never settles, still fails closed.
          let failed = false;
          let observeDetail;
          for (let attempt = 0; ; attempt += 1) {
            try {
              observation = await this._browser.observe({
                signal: undefined,
                initial: this._budgets.actionsUsed === 0 && this._budgets.plannerCallsUsed === 0,
              });
              break;
            } catch (error) {
              if (this._stopHappenedSince(epoch)) break;
              if (error?.code === "stale_document" && attempt < OBSERVE_STALE_RETRIES) {
                await new Promise((resolve) => setTimeout(resolve, this._observeRetryDelayMs));
                continue;
              }
              failed = true;
              observeDetail = `${error?.code || "error"}: ${String(error?.message || "").slice(0, 200)}`;
              break;
            }
          }
          if (this._stopHappenedSince(epoch)) break;
          if (failed) {
            if (await this._tryRecover("observation_error", "re-observe", observeDetail)) { this._reusableObservation = null; continue; }
            await this._pauseWith("observation_error", observeDetail);
            break;
          }
        }
        this._reusableObservation = null;
        if (this._stopHappenedSince(epoch)) break;
        // Tier 3 secrets (card, resident registration number, password, one-time code) never reach the planner or the journal.
        // A screenshot cannot be redacted: a page showing a secret goes to the planner as text only.
        this._secretOnScreen = hasSecretSurface(observation);
        observation = applyPrivacyTiers(observation);
        this._lastObservation = observation;
        if (this._completionChecklist && typeof observation?.text === "string" && observation.text) {
          this._observedTexts.delete(observation.url);
          this._observedTexts.set(observation.url, observation.text.slice(0, 20000));
          if (this._observedTexts.size > 40) this._observedTexts.delete(this._observedTexts.keys().next().value);
        }
        this._recordNavigation(observation);
        if (this._isResearchTask()) await this._recordResearchSource(observation);

        let customMemory = [];
        const memoryReads = startTurnMemoryReads({
          loadMemory: this._memoryStore ? () => this._memoryStore.forContext(observation.url) : undefined,
          recallActivity: this._activityRecall ? () => this._activityRecall(this._goal.originalRequest ?? "") : undefined,
        });
        try {
          customMemory = await memoryReads.memory;
        } catch {
          if (this._stopHappenedSince(epoch)) break;
          if (await this._tryRecover("context_error", "rebuild-context")) continue;
          await this._pauseWith("context_error");
          break;
        }
        if (this._stopHappenedSince(epoch)) break;
        // Context Awareness: pages the user read that match this request. Best
        // effort and untrusted like any memory entry; a failure never pauses work.
        if (this._branches) {
          const merged = this._branches.takeMerged();
          if (merged.length) customMemory = [...customMemory, ...merged];
        }
        if (this._activityRecall) {
          const recalled = await memoryReads.activity;
          if (recalled.length) customMemory = [...customMemory, ...recalled];
          if (this._stopHappenedSince(epoch)) break;
        }

        let pendingMessages = [];
        try {
          if (this._listPendingMessages) {
            pendingMessages = await this._listPendingMessages();
          }
        } catch {
          if (this._stopHappenedSince(epoch)) break;
          if (await this._tryRecover("context_error", "rebuild-context")) continue;
          await this._pauseWith("context_error");
          break;
        }
        if (this._stopHappenedSince(epoch)) break;

        let teamBoard = null;
        if (this._readTeamBoard) {
          teamBoard = await Promise.resolve().then(() => this._readTeamBoard()).catch(() => null);
          if (this._stopHappenedSince(epoch)) break;
        }

        // Offered only to a Multi-agent parent the host wired for child plans;
        // an unreadable plan state leaves the offer out of this turn.
        let childPlan;
        if (this._onChildPlan && this._readChildPlan && hasMultiAgentCapability(this._store.taskProfile)) {
          childPlan = await Promise.resolve().then(() => this._readChildPlan()).then((summary) => ({
            enabled: true,
            maxAgents: contracts.MAX_CHILD_ASSIGNMENTS,
            executionModes: Array.isArray(summary?.executionModes) ? summary.executionModes : ["host"],
            active: summary ? { agents: summary.agents.map((agent) => ({ subgoal: agent.subgoal ?? "", status: agent.status })) } : null,
          }), () => undefined);
          if (this._stopHappenedSince(epoch)) break;
        }

        // Staying on one page for most of the recent turns is a loop even if
        // each turn dispatches a different action (scroll, re-observe, search).
        {
          let pageKey = null;
          try { const u = new URL(observation?.url); pageKey = u.origin + u.pathname + u.search; } catch {}
          if (Number.isInteger(observation?.httpStatus) && typeof observation.url === "string" && !this._errorUrls.includes(observation.url)) {
            this._errorUrls.push(observation.url);
            if (this._errorUrls.length > ERROR_URLS_KEPT) this._errorUrls.shift();
          }
          // An anti-bot challenge is the person's to pass: hand the browser over
          // before any planner call, never try to click through it.
          // The first block on a site is routed around by asking the planner for another
          // source (the challenged URL goes into errorUrls); a repeat, a third site, or any
          // action other than leaving the page hands the task to the person.
          this._onCaptchaPage = false;
          // Looking again at the page the planner was just told to leave is not a second block.
          // Only the very next observation counts: once a page without a challenge has been
          // seen, a challenge on that site again is a repeat block.
          const lookingAgain = this._captchaNudgePending;
          this._captchaNudgePending = false;
          if (looksLikeCaptcha(observation?.url, observation?.title)) {
            let origin = null;
            try { origin = new URL(observation.url).origin; } catch {}
            if (origin === null || (this._captchaOrigins.has(origin) && !lookingAgain) || (!this._captchaOrigins.has(origin) && this._captchaOrigins.size >= CAPTCHA_SITES_TRIED)) {
              await this._pauseWith("captcha");
              break;
            }
            this._captchaOrigins.add(origin);
            this._onCaptchaPage = true;
            if (!this._errorUrls.includes(observation.url)) this._errorUrls.push(observation.url);
          }
          // A page this task has never been on is real progress: it refills the recovery
          // budget. Looping among pages already seen never does, so a stuck task stays bounded.
          if (pageKey !== null && !this._visitedPages.has(pageKey)) {
            this._visitedPages.add(pageKey);
            if (this._visitedPages.size > VISITED_PAGES_KEPT) this._visitedPages.delete(this._visitedPages.values().next().value);
            this._recovery.noteProgress();
          }
          this._recentPages.push(pageKey);
          if (this._recentPages.length > PAGE_LOOP_WINDOW) this._recentPages.shift();
          const stuckOnOne = pageKey !== null && this._recentPages.filter((k) => k === pageKey).length >= PAGE_LOOP_LIMIT;
          // Bouncing between two pages for a whole window is the same loop.
          const bouncing = this._recentPages.length === PAGE_LOOP_WINDOW && !this._recentPages.includes(null)
            && new Set(this._recentPages).size <= 2;
          if (stuckOnOne || bouncing) {
            if (await this._tryRecover("no_progress", "page-loop-warning")) {
              this._recentPages = [];
              this._loopHint = true;
              continue;
            }
            await this._store.append({ type: "note", payload: { msg: "most recent turns stayed on one page; pausing" } });
            await this._pauseWith("no_progress");
            break;
          }
        }

        let context;
        let visualCapture = null;
        let textCapture = null;
        const contextStartedAt = this._onTiming ? performance.now() : null;
        try {
          const contextManifest = this._contextRefsEnabled ? this._refreshContextRefs() : undefined;
          const workGoal = this._workGoalBinding && this._readWorkGoalContext
            ? await this._readWorkGoalContext({ ...this._workGoalBinding, taskId: this._goal.taskId })
            : undefined;
          if (this._stopHappenedSince(epoch)) break;
          // A blank start page has no boxes to read; the planner navigates first, then the next
          // observation is captured normally.
          const computerUseReady = hasComputerUseAdapter(this._store.taskProfile) && /^https?:/i.test(observation?.url ?? "");
          if (computerUseReady) {
            const imageInput = this._plannerImageInput && !this._secretOnScreen;
            if ((!imageInput && typeof this._browser.captureTextObservation !== "function") ||
                (typeof this._browser.captureTextObservation !== "function" && typeof this._browser.captureComputerUseObservation !== "function")) {
              await this._pauseWith("computer_use_unavailable");
              break;
            }
            try {
              const captureStartedAt = this._onTiming ? performance.now() : null;
              const capture = await capturePreferredObservation(this._browser, observation, {
                taskId: this._goal.taskId, imageInput,
                lastActionType: this._lastActionType, lastActionStatus: this._lastActionStatus,
              });
              textCapture = capture.textCapture; visualCapture = capture.visualCapture;
              if (typeof textCapture?.screenMap?.text === "string") textCapture = { ...textCapture, screenMap: { ...textCapture.screenMap, text: maskTier3(textCapture.screenMap.text) } };
              if (this._onTiming) { try { this._onTiming({ operation: "computer_use_capture", elapsedMs: performance.now() - captureStartedAt, route: capture.route, reason: capture.reason }); } catch {} }
              if (textCapture?.screenMap.sparse && this._visionAssist) {
                // Best effort: a failed description leaves the plain map.
                const described = await Promise.resolve(this._visionAssist(observation)).catch(() => null);
                if (typeof described === "string" && described.trim()) textCapture = { ...textCapture, visionNote: described.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 2048) };
              }
            } catch (error) {
              await this._store.append({ type: "note", payload: { kind: "computer_use_capture_error", code: String(error?.code ?? error?.message ?? "unknown").slice(0, 120) } }).catch(() => {});
              await this._pauseWith("computer_use_capture_failed");
              break;
            }
          }
          const targetList = textCapture ? textCapture.screenMap.targets : visualCapture?.screenTargets;
          this._screenTargets = Array.isArray(targetList) ? { observationId: observation.id, targets: targetList } : null;
          const plannerObservation = visualCapture
            ? { ...observation, computerUse: { ...visualCapture.binding } }
            : textCapture
              ? { ...observation, computerUse: { ...textCapture.binding, mode: "text" }, screenMap: textCapture.screenMap.text, ...(textCapture.visionNote ? { visionNote: textCapture.visionNote } : {}) }
              : observation;
          const recoveryFeedback = buildRecoveryFeedback(this._recovery.snapshot());
          const proposalFeedback = this._proposalFeedbackCode ? buildProposalFeedback(this._proposalFeedbackCode, {
            taskId: this._goal.taskId, goalVersion: this._goal.goalVersion,
            basedOnObservationId: observation.id, maxActions: this._maxActionsPerProposal,
          }) : null;
          context = buildContext({
            goal: this._goal,
            state: {
              criteriaStatus: this.getSnapshot().criteriaStatus,
              segment: { ...this._segment },
              budgets: { ...this._budgets },
              ...(recoveryFeedback ? { recoveryFeedback } : {}),
              ...(proposalFeedback ? { proposalFeedback } : {}),
              plannerEffort: this._effectivePlannerEffort(pendingMessages, observation?.url),
              harnessProfile: this._harnessProfile,
              maxActionsPerProposal: this._maxActionsPerProposal,
              ...(this._harnessProfile === "fast" ? { fastMode: true } : {}),
              ...(this._loopHint ? { loopWarning: true } : {}),
              ...(this._lastActionNote ? { lastAction: this._lastActionNote } : {}),
              ...(this._apiResponse ? { apiResponse: this._apiResponse } : {}),
              ...(this._osComputerUse ? { os: { enabled: true, ...(this._osObservation ? { observation: this._osObservation } : {}) } } : {}),
              ...(this._scrollStreak.count >= 3 ? { scrollStreak: this._scrollStreak.count } : {}),
              ...(this._errorUrls.length > 0 ? { errorUrls: [...this._errorUrls] } : {}),
              ...(this._finishFeedback ? { finishFeedback: { ...this._finishFeedback } } : {}),
              ...(this._repeatFeedback ? { repeatFailureFeedback: { ...this._repeatFeedback } } : {}),
              mcp: { enabled: this._mcpAvailableToPlanner(),
                actions: ["mcp_search", "mcp_describe", "mcp_propose"] },
              ...(this._harnessProfile === "long" ? { goalPersistence: this._goalPersistenceState() } : {}),
              ...(this._isResearchTask() ? { research: this._researchState() } : {}),
              ...(childPlan ? { childPlan } : {}),
            },
            navigation: { visited: [...this._navigation.visited], frontier: [...this._navigation.frontier] },
            observation: plannerObservation,
            recentEvents: this._store.eventsSinceCheckpoint || [],
            customMemory,
            strategyGuidance: this._strategyGuidance,
            textFocusQueries: process.env.HALO_TEXT_FOCUS === "1" ? [...this._textFocusQueries] : null,
            pendingMessages,
            ...(teamBoard ? { teamBoard } : {}),
            ...(this._workGoalBinding ? { workGoalBinding: this._workGoalBinding, workGoal } : {}),
            ...(contextManifest ? { contextManifest } : {}),
          });
          if (this._pendingContextRead) {
            const candidate = { ...context, observation: { ...(context.observation || {}), contextRead: this._pendingContextRead } };
            if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= contracts.MAX_CONTEXT_PACKET_BYTES) {
              context = candidate;
            } else {
              // Keep the answer honest when the bodies do not fit: every ref
              // is reported, none as an empty success.
              const omitted = { authority: "context_read", truncated: true,
                results: this._pendingContextRead.results.map((r) => ({ refId: r.refId, outcome: "error", code: "context_read_omitted" })) };
              context = { ...context, observation: { ...(context.observation || {}), contextRead: omitted } };
            }
          }
          if (this._pendingMcpObservation) {
            const observationWithMcp = { ...(context.observation || {}), mcpResult: this._pendingMcpObservation };
            const candidate = { ...context, observation: observationWithMcp };
            if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > contracts.MAX_CONTEXT_PACKET_BYTES) {
              const compact = boundedMcpObservation(this._pendingMcpObservation.action, this._pendingMcpObservation.outcome,
                "", { code: this._pendingMcpObservation.code || "result_omitted", truncated: true });
              const compactCandidate = { ...context, observation: { ...(context.observation || {}), mcpResult: compact } };
              if (Buffer.byteLength(JSON.stringify(compactCandidate), "utf8") > contracts.MAX_CONTEXT_PACKET_BYTES) throw new Error("MCP observation exceeds context budget");
              this._pendingMcpObservation = compact;
              context = compactCandidate;
            } else {
              context = candidate;
            }
          }
        } catch {
          await visualCapture?.attachment?.dispose?.().catch(() => {});
          if (this._stopHappenedSince(epoch)) break;
          if (await this._tryRecover("context_error", "rebuild-context")) continue;
          await this._pauseWith("context_error");
          break;
        }
        if (this._onTiming) {
          const elapsedMs = Math.max(0, performance.now() - contextStartedAt);
          try { this._onTiming({ operation: "context_build", elapsedMs, bytes: Buffer.byteLength(JSON.stringify(context), "utf8") }); } catch {}
        }
        // The admitted subset only -- never mutated after this point. Used
        // below to durably acknowledge exactly what was actually shown to
        // the planner, before its proposal is handled (fail-closed: see the
        // recordMessagesConsumed block right after planner.next() resolves).
        const admittedMessageIds = context.pendingMessages.map((m) => m.messageId);

        let proposal;
        if (this._stopHappenedSince(epoch)) break;
        // Budget attempted turns, not only answers. Otherwise repeated
        // cancellation/timeouts could spend model calls without consuming
        // the host-owned limit; a pause checkpoint preserves this charge.
        this._budgets.plannerCallsUsed += 1;
        try {
          try {
            proposal = await this._nextPlanner(context, visualCapture ? { attachments: [{ kind: "image", id: visualCapture.attachment.id, path: visualCapture.attachment.path }] } : {});
          } catch (firstError) {
            // Repair format against the same observation, but with bounded
            // host feedback, not the provider's raw error or rejected output.
            if (!PLANNER_RETRYABLE_CODES.includes(firstError?.plannerCode) || this._stopHappenedSince(epoch)) throw firstError;
            const activeMs = this._budgets.activeMs + (this._activeSince !== null ? this._now() - this._activeSince : 0);
            if (this._budgets.plannerCallsUsed >= this._goal.limits.maxPlannerCalls || activeMs >= this._goal.limits.maxActiveMs) {
              await this._pauseWith("budget_exhausted");
              break;
            }
            this._proposalFeedbackCode = firstError.plannerCode;
            const repairContext = { ...context, progress: { ...context.progress,
              budgets: { ...this._budgets, plannerCallsUsed: this._budgets.plannerCallsUsed + 1 }, proposalFeedback: buildProposalFeedback(firstError.plannerCode, {
                taskId: this._goal.taskId, goalVersion: this._goal.goalVersion,
                basedOnObservationId: context.observation.id, maxActions: this._maxActionsPerProposal,
              }) } };
            if (Buffer.byteLength(JSON.stringify(repairContext), "utf8") > contracts.MAX_CONTEXT_PACKET_BYTES) throw firstError;
            this._budgets.plannerCallsUsed += 1;
            proposal = await this._nextPlanner(repairContext, visualCapture ? { attachments: [{ kind: "image", id: visualCapture.attachment.id, path: visualCapture.attachment.path }] } : {});
          }
          if (this._pendingMcpObservation) this._pendingMcpObservation = null;
          this._pendingContextRead = null;
          this._loopHint = false;
          this._finishFeedback = null;
          this._repeatFeedback = null;
        } catch (error) {
          if (this._stopHappenedSince(epoch)) break;
          // planner-stdio.js's PlannerTransportError distinguishes "no
          // worker command is configured at all" (code "planner_unavailable")
          // from a genuine transport failure (timeout, malformed response,
          // etc.) -- the design doc requires the former to surface honestly
          // as its own pause reason rather than the generic planner_error,
          // so a host UI can tell "nothing is wired up" apart from "the
          // configured planner broke".
          const routinePause = ["routine_step_unresolved", "routine_origin_violation", "routine_cursor_mismatch", "invalid_routine"]
            .includes(error?.code) ? error.code : null;
          // The pause reason alone hides why the planner failed; leave the
          // cause in the process log so a paused task can be diagnosed.
          try { console.warn(`[task-controller] planner failed task=${this._goal?.taskId ?? "?"} code=${error?.code ?? "none"}: ${String(error?.message ?? error).slice(0, 500)}`); } catch {}
          if (!routinePause && error?.code !== "planner_unavailable" && error?.code !== "computer_use_provider_unavailable"
              && await this._tryRecover("planner_error", "retry-planner")) continue;
          await this._pauseWith(routinePause || (error && error.code === "planner_unavailable" ? "planner_unavailable"
            : error?.code === "computer_use_provider_unavailable" ? "computer_use_provider_unavailable" : "planner_error"));
          break;
        } finally {
          await visualCapture?.attachment?.dispose?.().catch(() => {});
        }
        if (this._stopHappenedSince(epoch)) break;

        // Subagent communication protocol Task 4 (Review Focus: "crash/
        // failure after planner response but before durable
        // message_turn_consumed must not process the generated proposal").
        // Durably ack exactly the admitted batch BEFORE the proposal below
        // is ever validated/dispatched; a stop that raced in above already
        // broke out, so a stopped controller never marks a steer observed.
        if (admittedMessageIds.length > 0 && !this._recordMessagesConsumed) {
          await this._pauseWith("message_ack_unavailable");
          break;
        }
        if (admittedMessageIds.length > 0) {
          try {
            await this._recordMessagesConsumed(admittedMessageIds, this._budgets.plannerCallsUsed);
          } catch {
            if (this._stopHappenedSince(epoch)) break;
            await this._pauseWith("message_ack_failed");
            break;
          }
        }
        if (this._stopHappenedSince(epoch)) break;

        this._segment.callsInSegment += 1;
        if (this._segment.callsInSegment >= this._segmentRotationCalls) {
          this._segment.callsInSegment = 0;
          this._segment.index += 1;
        }
        this._emit();

        let validated;
        try {
          validated = validateProposal(proposal, { goal: this._goal, maxActions: this._maxActionsPerProposal });
          if (validated.basedOnObservationId !== observation.id) {
            throw new TaskControllerError("stale_observation", "proposal must reference the current observation");
          }
        } catch (error) {
          // An off-goal/stale/malformed proposal is never executed; give the
          // planner one correction turn with a fresh observation and binding.
          this._proposalFeedbackCode = buildProposalFeedback(error?.code, {
            taskId: this._goal.taskId, goalVersion: this._goal.goalVersion,
            basedOnObservationId: observation.id, maxActions: this._maxActionsPerProposal,
          }).code;
          this._rejectedProposals += 1;
          if (this._rejectedProposals >= 2) {
            await this._pauseWith("invalid_proposal");
            break;
          }
          continue;
        }
        this._proposalFeedbackCode = null;
        this._rejectedProposals = 0;

        if (this._onCaptchaPage && validated.kind === "actions") {
          const staysOut = validated.actions.every((action) => {
            if (action.type === "observe") return true;
            if (action.type !== "navigate" && action.type !== "follow_link") return false;
            try { return !this._captchaOrigins.has(new URL(describeActionTarget(action, this._lastObservation)).origin); } catch { return false; }
          });
          if (!staysOut) {
            // The planner is told once to leave the challenge page and use another source; only if it
            // tries to act on the challenge again does the task wait for the person.
            if (this._captchaNudges < 1) {
              this._captchaNudges += 1;
              this._captchaNudgePending = true;
              this._proposalFeedbackCode = "captcha_page";
              await this._store.append({ type: "note", payload: { kind: "captcha_page_nudge" } });
              continue;
            }
            await this._pauseWith("captcha");
            break;
          }
        }

        const coordinateActions = validated.kind === "actions"
          ? validated.actions.filter((action) => action.type === "click_at" || action.type === "type_at" || action.type === "press_key" || action.type === "play_loop")
          : [];
        if (coordinateActions.length > 0 && (!hasComputerUseAdapter(this._store.taskProfile) ||
            coordinateActions.length !== 1 || validated.actions.length !== 1 ||
            validated.basedOnObservationId !== observation.id || coordinateActions[0].observationId !== observation.id)) {
          // A coordinate proposal has no authority unless it names the exact
          // one-use image observation delivered on this turn.
          continue;
        }

        if (validated.kind === "finish") {
          const completion = canComplete(this._goal, this._evidenceForCompletionCheck());
          if (!completion.complete && this._harnessProfile === "long" && this._onlyHostVerifiable(completion.missingIds)) {
            this._rejectedFinishes += 1;
            await this._store.append({ type: "note", payload: {
              kind: "finish_rejected",
              missingCriterionIds: completion.missingIds,
              rejectedFinishes: this._rejectedFinishes,
            } });
            if (this._rejectedFinishes >= GOAL_MAX_REJECTED_FINISHES) {
              await this._pauseWith("goal_not_reached");
              break;
            }
            continue; // the goal is not met: keep working, the planner is told why via context.progress.goalPersistence
          }
          if (this._completionChecklist && !this._routineRunner) {
            const check = this._completionChecklist({ kind: "finish", answer: "", goalText: this._goal?.originalRequest ?? "", observation: this._lastObservation, observedTexts: [...this._observedTexts.values()], observedUrls: [...this._observedTexts.keys()] });
            if (!check.ok) {
              await this._store.append({ type: "note", payload: { kind: "completion_checklist_failed", codes: check.failures.map((f) => f.code), rejected: this._completionRejected, on: "finish" } });
              if (this._completionRejected < 2) {
                this._completionRejected += 1;
                this._repeatFeedback = { note: "completion_checklist_failed", guidance: check.failures.map((f) => f.guidance).join(" ") };
                continue;
              }
            }
          }
          // A routine's finish is scripted by the routine, not proposed by a planner, so there is no one to send it back to.
          if (!this._routineRunner && !completion.complete && this._criteriaStatus.size === 0 && this._finishEvidenceRejections < this._finishEvidenceBudget) {
            this._finishEvidenceRejections += 1;
            this._finishFeedback = {
              authority: "host_finish_not_permission",
              reason: "no_evidence_recorded",
              guidance: "finish needs evidence: no criterion has a recorded observation yet. Check that the CURRENT page shows exactly what the goal asks for (the requested item, value or state, not just a related page, a search box or a landing page). If it does, propose one observe with that criterionId, then finish. If it does not, keep working toward it.",
            };
            await this._store.append({ type: "note", payload: { kind: "finish_rejected", reason: "no_evidence_recorded", rejections: this._finishEvidenceRejections } });
            continue;
          }
          this._leaveActive();
          if (completion.complete) {
            this._task = { state: "completed", pauseReason: null };
            await this._revokeAllLeases("task_ended");
          } else {
            this._task = { state: "awaiting_verification", pauseReason: null };
          }
          await this._checkpoint();
          if (this._releaseViewsOnReview && this._task.state === "awaiting_verification") await this._releaseViewsForReview();
          this._emit();
          break;
        }

        if (validated.kind === "need_user") {
          // The planner's question is what the person needs to answer; keep it
          // (bounded) so the chat can show it instead of a bare "paused".
          let reasonText = typeof validated.reason === "string" ? validated.reason.trim() : "";
          let reasonCap = 600;
          let answerVerified = false;
          const modelAnswer = reasonText; // the checklist reads what the model wrote, not the host's appended source block
          if (reasonText && this._isResearchTask()) {
            // A research answer reaches the person only after the host checked its sources.
            const review = await this._reviewResearchAnswer(reasonText);
            if (review.action === "retry") continue;
            reasonText = review.text;
            reasonCap = RESEARCH_REASON_CAP;
            answerVerified = review.verified === true;
          }
          if (reasonText && this._completionChecklist) {
            const check = this._completionChecklist({ answer: modelAnswer, goalText: this._goal?.originalRequest ?? "", observation: this._lastObservation, observedTexts: [...this._observedTexts.values()], observedUrls: [...this._observedTexts.keys()] });
            if (!check.ok) {
              await this._store.append({ type: "note", payload: { kind: "completion_checklist_failed", codes: check.failures.map((f) => f.code), rejected: this._completionRejected } });
              if (this._completionRejected < 2) {
                this._completionRejected += 1;
                this._repeatFeedback = { note: "completion_checklist_failed", guidance: check.failures.map((f) => f.guidance).join(" ") };
                continue;
              }
            }
          }
          if (!answerVerified && this._giveUpRefused < this._giveUpRefusals) {
            // Nobody is there to help: keep working until the budget or the clock ends the task.
            this._giveUpRefused += 1;
            this._repeatFeedback = {
              note: "give_up_refused",
              guidance: "No person is available to answer. Do not stop to ask. Try another route, another site or another search, and report need_user only with an answer whose cited pages you opened.",
            };
            await this._store.append({ type: "note", payload: { kind: "give_up_refused", refused: this._giveUpRefused } });
            continue;
          }
          this._needUserReason = reasonText ? reasonText.slice(0, reasonCap) : null;
          try { console.warn(`[task-controller] planner asked for the user task=${this._goal?.taskId ?? "?"} reason=${JSON.stringify(this._needUserReason)}`); } catch {}
          await this._pauseWith("need_user");
          break;
        }

        if (validated.kind === "replan") {
          continue; // model asked to reconsider; no dispatch, just loop again
        }

        if (validated.kind === "child_plan") {
          if (!hasMultiAgentCapability(this._store.taskProfile)) {
            await this._pauseWith("child_plan_not_authorized");
            break;
          }
          if (!this._onChildPlan) {
            // No parent-level delegation handler wired on this controller --
            // never silently pretend to have spawned anything; give the
            // planner another turn with a fresh observation instead.
            continue;
          }
          try {
            await this._onChildPlan(validated);
          } catch (error) {
            await this._pauseWith("child_plan_failed");
            break;
          }
          continue; // the parent's own loop keeps observing/planning independently of its children
        }

        if (validated.kind === "send_message") {
          if (!this._sendMessage) {
            // Without the coordinator boundary, the message cannot be
            // authenticated or durably accepted. Do not silently drop it.
            await this._pauseWith("send_message_unavailable");
            break;
          }
          try {
            await this._sendMessage(validated);
          } catch (error) {
            await this._pauseWith("send_message_failed");
            break;
          }
          continue; // host messaging, not a browser action; never mutates an in-flight action
        }

        if (this._contextRefsEnabled && validated.actions.some((action) => action?.type === "context_read")) {
          if (validated.actions.length !== 1 || !plannerContextRead(validated.actions[0])) continue;
          if (this._budgets.actionsUsed >= this._goal.limits.maxActions) {
            await this._pauseWith("budget_exhausted");
            break;
          }
          this._budgets.actionsUsed += 1;
          const scope = { taskId: this._goal.taskId, goalVersion: this._goal.goalVersion, documentEpoch: this._lastObservation?.documentEpoch ?? null };
          try {
            this._pendingContextRead = this._contextRefs.read(validated.actions[0].refIds, scope);
          } catch (error) {
            this._pendingContextRead = { authority: "context_read", truncated: false, results: [],
              code: typeof error?.code === "string" ? error.code : "context_read_error" };
          }
          continue; // host-only read: no browser dispatch, nothing to approve
        }

        const mcpActions = validated.actions.filter((action) => typeof action.type === "string" && action.type.startsWith("mcp_"));
        if (mcpActions.length > 0) {
          if (validated.actions.length !== 1 || mcpActions.length !== 1 || !plannerMcpAction(mcpActions[0])) continue;
          if (this._budgets.actionsUsed >= this._goal.limits.maxActions) {
            await this._pauseWith("budget_exhausted");
            break;
          }
          this._budgets.actionsUsed += 1;
          this._pendingMcpObservation = await this._handlePlannerMcpAction(mcpActions[0], epoch);
          if (this._task.state !== "running" || this._stopHappenedSince(epoch)) break;
          continue;
        }

        // kind === "actions"
        const outcome = await this._dispatchActionsBatch(validated, epoch);
        if (outcome === "stop_loop") break;
      }
    } finally {
      this._loopRunning = false;
    }
    return this.getSnapshot();
  }

  _evidenceForCompletionCheck() {
    // Each entry keeps the goalVersion it was actually verified under (set
    // in _afterActionDispatched), NOT the controller's current goalVersion --
    // otherwise a criterion verified before an amend() would silently keep
    // counting toward the NEW version's completion, defeating progress.js's
    // canComplete() re-verification-after-amendment check.
    const evidence = [];
    for (const [criterionId, v] of this._criteriaStatus.entries()) {
      if (v.status === "verified") {
        evidence.push({ criterionId, verification: "verified", goalVersion: v.goalVersion });
      }
    }
    return evidence;
  }

  // The addresses on the person's own machine or network that the person named in their own words:
  // the agent's page may open only these (private-network.js). A request a model wrote names none.
  _personNamedPrivateOrigins() {
    const own = [...(this._requestAuthor === "person" ? [this._goal.originalRequest] : []), ...this._goal.amendments.filter((a) => a.authority === "user").map((a) => a.text)];
    return privateOriginsNamedIn(own.filter((text) => typeof text === "string").join("\n"));
  }

  // The user's chat request is the payment authorization. Read it once per goal
  // version: a clear order becomes a single-use mandate, an unclear one pauses the
  // task with a question, and anything else leaves payments refused. Unattended
  // runs (routines, schedules) never get one, and a goal version that already paid
  // never gets a second.
  async _ensureMandate() {
    const version = this._goal.goalVersion;
    if (this._mandateGoalVersion === version) return "ok";
    this._mandateGoalVersion = version;
    for (const old of this._mandates) old.revoked = true;
    const chatText = [this._goal.originalRequest, ...this._goal.amendments.filter((a) => a.authority === "user").map((a) => a.text)].filter((t) => typeof t === "string").join("\n");
    if (containsTier3(chatText)) {
      await this._store.append({ type: "note", payload: { kind: "card_in_chat" } });
      this._needUserReason = "채팅에 카드 번호나 주민등록번호 같은 민감한 정보가 있는 것 같습니다. 이런 정보는 Halo에 알려 주지 말고 화면에서 직접 입력해 주세요. 이미 보낸 정보가 있다면 카드 재발급 등 조치를 권장합니다.";
      await this._pauseWith("need_user");
      return "stop_loop";
    }
    if (!this._paymentsEnabled) return "ok";
    if (this._routineRunner || this._goal.trigger) return "ok";
    if (this._requestAuthor === "model") return "ok";
    const userText = [this._goal.originalRequest, ...this._goal.amendments.filter((a) => a.authority === "user").map((a) => a.text)].filter((t) => typeof t === "string").join("\n");
    const verdict = payments.mandateFromUserRequest(userText);
    if (verdict.kind === "none") return "ok";
    if (verdict.kind === "ask") {
      await this._store.append({ type: "note", payload: { kind: "payment_question", reason: verdict.reason } });
      this._needUserReason = verdict.question;
      await this._pauseWith("need_user");
      return "stop_loop";
    }
    const paid = (await this._store.getAllEvents()).some((e) => e.type === "note" && e.payload?.kind === "payment_authorized" && e.goalVersion === version);
    if (paid) return "ok";
    const mandate = payments.createMandate({ id: randomUUID(), taskId: this._goal.taskId, origin: verdict.origin, currency: verdict.currency, maxAmountMinor: verdict.maxAmountMinor, now: this._monotonicNow(), wallNow: Date.now() });
    await this._store.append({ type: "note", payload: { kind: "mandate_granted", mandateId: mandate.id, origin: mandate.origin, currency: mandate.currency, maxAmountMinor: mandate.maxAmountMinor, expiresAt: mandate.expiresAt } });
    this._mandates.push(mandate);
    return "ok";
  }

  // Privacy tiers for typing: Tier 3 fields and values are the person's to type; a Tier 2 value
  // (phone, email) is typed only if the user wrote it in this task's request.
  // What the host's safety checks (action-safety.js) need to know about the page right now.
  _safetyContext() {
    const userText = [this._goal.originalRequest, ...this._goal.amendments.filter((a) => a.authority === "user").map((a) => a.text)].filter((t) => typeof t === "string").join("\n");
    return { observation: this._lastObservation, screenTargets: this._screenTargets, computerUse: hasComputerUseAdapter(this._store.taskProfile), userText };
  }

  // Source-grounded research (capability "research"): the host, not the model, decides which sources
  // an answer may cite. See research-sources.js.
  _isResearchTask() {
    return this._groundAnswers || this._store.taskProfile?.capability?.id === "research";
  }

  async _hydrateResearchLedger() {
    if (this._researchLedger) return this._researchLedger;
    const ledger = new research.SourceLedger();
    let rejections = 0;
    for (const event of await this._store.getAllEvents()) {
      if (event.type !== "note") continue;
      if (event.payload?.kind === "research_source" && typeof event.payload.url === "string") ledger.add({ url: event.payload.url, title: event.payload.title, at: event.payload.at });
      else if (event.payload?.kind === "research_answer_rejected") rejections += 1;
    }
    this._researchLedger = ledger;
    this._researchRejections = Math.max(this._researchRejections, rejections);
    return ledger;
  }

  // Only a page this host actually observed (a real page, not an error page) can become a source.
  async _recordResearchSource(observation) {
    const ledger = await this._hydrateResearchLedger();
    const url = typeof observation?.url === "string" ? observation.url : "";
    if (!/^https?:\/\//i.test(url) || (Number(observation?.httpStatus) >= 400)) return;
    const title = typeof observation.title === "string" ? observation.title : "";
    const at = Date.now();
    if (!ledger.add({ url, title, at })) return;
    const entry = ledger.find(url);
    await this._store.append({ type: "note", payload: { kind: "research_source", url: entry.url, title: entry.title, at } });
  }

  // What the planner is told: which pages it may cite and why an earlier answer was sent back.
  _researchState() {
    const opened = this._researchLedger ? this._researchLedger.list().slice(-12).map((s) => ({ url: s.url.slice(0, 300), title: s.title.slice(0, 80) })) : [];
    return {
      requiredIndependentSites: research.MIN_DOMAINS,
      openedSources: opened,
      rejectedAnswers: this._researchRejections,
      ...(this._researchFeedback ? { lastRejection: this._researchFeedback } : {}),
    };
  }

  // Returns { action: "retry" } to send the answer back, or { action: "deliver", text } with the text to show.
  // Answers that cite nothing and follow no browsing are plain questions to the person and pass untouched.
  async _reviewResearchAnswer(answer) {
    const ledger = await this._hydrateResearchLedger();
    if (ledger.size === 0 && research.extractCitedUrls(answer).length === 0) return { action: "deliver", text: answer };
    const check = research.checkAnswer(answer, ledger);
    if (check.ok) {
      await this._store.append({ type: "note", payload: { kind: "research_answer_checked", sources: check.verified.length, sites: check.independentSites } });
      this._researchFeedback = null;
      return { action: "deliver", verified: true, text: answer + research.sourcesBlock(check.verified) };
    }
    if (this._researchRejections < research.MAX_REJECTIONS) {
      this._researchRejections += 1;
      this._researchFeedback = { reasons: check.reasons, unopenedUrls: check.unverified.slice(0, 5).map((u) => u.slice(0, 200)) };
      await this._store.append({ type: "note", payload: { kind: "research_answer_rejected", reasons: check.reasons, unopened: check.unverified.length, sites: check.independentSites } });
      return { action: "retry" };
    }
    await this._store.append({ type: "note", payload: { kind: "research_answer_unverified_delivered", reasons: check.reasons, unopened: check.unverified.length, sites: check.independentSites } });
    return { action: "deliver", text: answer + research.sourcesBlock(check.verified) + research.unverifiedNotice(check) };
  }

  // The control a payment-like action would press, or null. Only the host's own
  // reads count: the screen map for coordinate clicks, the last observation for DOM clicks.
  // pay: the user's order covers this payment; ask: pause with a question;
  // refuse/null: nobody ordered a payment, the existing gates apply unchanged.
  async _decidePayment(action, target) {
    if (!this._paymentsEnabled) return null;
    if (!target) return null;
    const observation = this._lastObservation;
    // Where the money goes: a payment button that submits to another site is judged by that site, not by the page it sits on.
    const origin = actionTargetOrigin(action, observation);
    const request = { origin, amount: payments.findPayableAmount(target.name, observation) };
    const verdict = payments.decidePayment({ mandates: this._mandates, request, now: this._monotonicNow() });
    if (verdict.decision === "pay") {
      const m = verdict.mandate;
      payments.consumeMandate(m); // spent before the journal write: a failed write never hands the use back
      await this._store.append({ type: "note", payload: { kind: "payment_authorized", mandateId: m.id, origin, currency: m.currency, amountMinor: request.amount.amountMinor, maxAmountMinor: m.maxAmountMinor, control: target.name.slice(0, 80) } });
      return verdict;
    }
    if (verdict.decision === "ask") {
      await this._store.append({ type: "note", payload: { kind: "payment_question", reason: verdict.reason } });
      this._needUserReason = verdict.question;
      await this._pauseWith("need_user");
    }
    return verdict;
  }

  // Stops an action the planner keeps repeating: the same one that failed the same way too often, or one kind (find_text
  // with a new phrase each time) used too often lately. Returns null to run it, else the loop outcome after telling the planner.
  async _repeatGuard(action) {
    if (!(this._repeatFailureLimit > 0)) return null;
    const family = actionFamily(action);
    let guidance = null;
    let blockedFamily = null;
    if (family && this._familyWindow.filter((f) => f === family).length >= FAMILY_BLOCK) {
      blockedFamily = family;
      guidance = `You have used ${family} many times in the last few actions without getting further, so this one was not run. Take a different route: another link or section of the site, a page you have not opened, or report what you found.`;
    } else if ((this._repeatFailures.get(repeatActionKey(action)) ?? 0) >= this._repeatFailureLimit) {
      guidance = "This exact action already failed repeatedly with the same error and was not run again. Change the target, the approach or the page, or report need_user.";
    }
    if (!guidance) return null;
    this._repeatBlocked += 1;
    this._repeatFeedback = { note: "repeat_blocked", actionType: action.type, guidance };
    await this._store.append({ type: "note", payload: { kind: "repeat_blocked", actionType: action.type, ...(blockedFamily ? { family: blockedFamily } : {}), blocked: this._repeatBlocked } });
    if (this._repeatBlocked >= REPEAT_BLOCK_PAUSE) {
      await this._pauseWith("no_progress");
      return "stop_loop";
    }
    return "continue";
  }

  async _dispatchActionsBatch(proposal, epoch) {
    if (this._batchReadOnlyActions && proposal.actions.length > 1 && proposal.actions.every((action) => isReadOnlyAction(action.type))) {
      const outcome = await this._dispatchReadOnlyBatch(proposal, epoch);
      if (outcome !== "individual") return outcome;
    }
    for (const action of proposal.actions) {
      if (this._budgets.actionsUsed >= this._goal.limits.maxActions) {
        await this._pauseWith("budget_exhausted");
        return "stop_loop";
      }

      const pressure = this._memoryMonitor.getPressureLevel();
      if (pressure === "pause" || pressure === "emergency") {
        await this._pauseForMemoryPressure(pressure);
        return "stop_loop";
      }

      // One pass over the host's safety checks for this action (action-safety.js). An action type nobody
      // declared there is not run: fail closed rather than skip a check silently.
      const safety = inspectAction(action, this._safetyContext());
      if (safety.undeclared) {
        await this._store.append({ type: "note", payload: { kind: "invalid_action", actionType: String(action?.type).slice(0, 40), errorCode: "action_safety_undeclared" } });
        continue;
      }
      const blocked = await this._repeatGuard(action);
      if (blocked) return blocked;
      const privacy = safety.privacy;
      if (privacy) {
        // Secrets are typed by the person, never by the agent; nothing of the text is journaled.
        await this._store.append({ type: "note", payload: { kind: privacy.tier === 3 ? "card_input_blocked" : "personal_input_blocked", tier: privacy.tier, actionType: action.type } });
        this._needUserReason = privacy.reason;
        await this._pauseWith("need_user");
        return "stop_loop";
      }

      const requestId = randomUUID();
      const descriptor = this._describeAction(action, requestId);

      let decision;
      // Lock first (nothing overrides it, and a denied action never reaches
      // the approver or the browser), then the mode, then any live lease.
      const targetOrigin = actionTargetOrigin(action, this._lastObservation);
      const gate = evaluateGate({ lock: this._goal.lock ?? null, mode: this._permissionMode, leases: this._leases, action: action.type, targetOrigin, now: this._monotonicNow() });
      if (gate.outcome === "lock_denied") {
        await this._store.append({ type: "note", payload: { kind: "lock_denied", actionType: action.type, reason: gate.reason, ruleIndex: gate.ruleIndex } });
        if (this._routineRunner) {
          await this._denyRoutineStep({ decision: "deny", reasons: [gate.reason] });
          return "stop_loop";
        }
        continue;
      }
      // A payment button the user ordered in chat, within their cap and on their
      // site, is let through to the approver alone; an odd one asks the user.
      const paymentVerdict = await this._decidePayment(action, safety.paymentTarget);
      if (paymentVerdict?.decision === "ask") return "stop_loop";
      const paymentOk = paymentVerdict?.decision === "pay";
      // Text mode only (the control under the point is known): a click on a
      // control that moves money or destroys an account is refused whatever the
      // permission mode, lease or approver says. The planner sees the note.
      const verdict = safety.effect;
      if (verdict && verdict.gate === "deny" && !paymentOk) {
        await this._store.append({ type: "note", payload: { kind: "effect_denied", actionType: action.type, effect: verdict.effect, reason: verdict.reason } });
        if (this._routineRunner) {
          await this._denyRoutineStep({ decision: "deny", reasons: [verdict.reason] });
          return "stop_loop";
        }
        continue;
      }
      // Computer use: coordinate clicks, typing and non-Enter keys run on the
      // approver's verdict alone. The mode, lock and one-use screen binding still
      // apply; Enter (which can submit a form) keeps the human gate.
      const autoRun = gate.policy.allowed && gate.policy.approval === "human" &&
        (paymentOk || isAutoComputerUseAction(action, this._store.taskProfile, this._screenTargets) || isAutoDomAction(action, this._lastObservation));
      let policy = autoRun ? { ...gate.policy, approval: "approver" } : gate.policy;
      // Full mode skips approval for ordinary actions, but a payment click that no order covers
      // (payments off, no order, other site) goes back to the person instead of becoming a silent purchase.
      if (policy.approval === "bypass" && !paymentOk && safety.paymentTarget) policy = { ...policy, approval: "human" };
      // Mode-denied actions may be widened by the user, but never for
      // unattended runs or for actions this browser cannot perform.
      const widen = !policy.allowed;
      if (widen && (this._routineRunner || this._reviewFallback === "deny" ||
          this._browser.supportsAction?.(action.type) === false || policy.reason === "unsupported_action")) {
        if (this._routineRunner) {
          await this._denyRoutineStep({ decision: "deny", reasons: [policy.reason || "permission_mode_denied"] });
          return "stop_loop";
        }
        continue;
      }
      // A lease can only stand in for the user, never for the approver: an
      // action that needs the user (widened, or human-review with a live
      // lease) is first judged by the approver, and only its allow may be
      // turned into a lease use.
      const leasable = !!gate.lease && this._reviewFallback !== "deny";
      const needsUser = widen || policy.approval === "human";
      try {
        decision = widen || (policy.approval === "human" && leasable)
          ? await this._approve(descriptor)
          : policy.approval === "bypass"
            ? { decision: "allow", reasons: ["explicit_full_permission"] }
            : policy.approval === "human"
              ? { decision: "review", reasons: ["human_confirmation_required"] }
              : await this._approve(descriptor);
      } catch {
        if (this._stopHappenedSince(epoch)) return "stop_loop";
        await this._pauseWith("approver_error");
        return "stop_loop";
      }
      if (this._stopHappenedSince(epoch)) return "stop_loop";
      // The approver's allow does not lift the mode or the human gate; the
      // user (or a lease they lent) still decides. Its deny/quarantine/review
      // is final: no widening or lease ever overrides it.
      const approverAllowed = needsUser && decision.decision === "allow";
      if (approverAllowed) {
        decision = { decision: "review", reasons: [...(Array.isArray(decision.reasons) ? decision.reasons : []), widen ? "permission_mode_denied" : "human_confirmation_required"] };
      }
      let widenedBy = null;
      // The approver may have taken time: re-check the lease at use time. A
      // lease that died meanwhile leaves the request for the user.
      if (approverAllowed && leasable) {
        widenedBy = await this._useLease(gate.lease, requestId);
        if (widenedBy) decision = { decision: "allow", reasons: ["capability_lease"] };
      }
      decision = await this._applyReviewFallback(decision, action.type);

      if (decision.decision === "review") {
        this._approvalQueue.push({
          id: requestId,
          summary: descriptor.summary,
          actionType: action.type,
          createdAt: new Date().toISOString(),
          // Approval-binding contract (design doc section 7): a queued item
          // is only ever dispatchable while the epoch it was queued under is
          // still current (pause/stop/amend all bump the epoch, so any of
          // them invalidates it) and before its 60s window expires. See
          // approve()'s staleness check below.
          epoch,
          goalVersion: this._goal.goalVersion,
          expiresAt: this._now() + contracts.APPROVAL_EXPIRY_MS,
          deadline: this._monotonicNow() + contracts.APPROVAL_EXPIRY_MS,
          descriptor,
          action,
          proposal,
          widen,
          targetOrigin,
          // Offered only for what this browser can really run: a lease for an
          // action it cannot perform would only ever fail.
          leaseOffer: targetOrigin && LEASE_ACTIONS.includes(action.type) && this._browser.supportsAction?.(action.type) === true
            ? { action: action.type, origin: targetOrigin }
            : null,
        });
        this._leaveActive();
        this._task = { state: "awaiting_approval", pauseReason: null };
        // Independent reads the planner named run on a read-only side surface while the user decides.
        this._branches?.offer({ approvalId: requestId, steps: proposal?.waitingWork, pendingOrigin: targetOrigin ?? null });
        await this._checkpoint();
        this._emit();
        return "stop_loop";
      }
      if (decision.decision !== "allow") {
        // deny/quarantine: skip this action, keep the loop going with the rest.
        if (this._routineRunner && (decision.decision === "deny" || decision.decision === "quarantine")) {
          await this._denyRoutineStep(decision);
          return "stop_loop";
        }
        continue;
      }

      const dispatched = await this._dispatchApprovedAndApplyTracked(proposal, descriptor, action, epoch, { widenedBy });
      if (!dispatched.stale && (autoRun || widenedBy)) this._autoHandled += 1;
      if (dispatched.stale || this._stopHappenedSince(epoch)) return "stop_loop";
      if (this._stopHappenedSince(epoch) || this._task.state !== "running") return "stop_loop";
    }
    return "continue";
  }

  _describeAction(action, requestId, suffix = "") {
    const target = describeActionTarget(action, this._lastObservation, this._screenTargets);
    return {
      requestId,
      action: action.type,
      origin: (this._lastObservation && this._lastObservation.url) || "",
      target,
      summary: `${target ? `Planner proposes ${action.type}: ${target}` : `Planner proposes ${action.type}`}${suffix}`,
      selfProvenance: "untrusted",
      source: "page_content",
      targetScope: "external",
    };
  }

  // Read-only batch (design 2026-09-29-readonly-action-batching): the approver judges each distinct action type
  // once for the whole batch, and only the last action's records are durable. Returns "individual" when policy
  // does not allow every action, so the ordinary per-action path keeps its own skip/deny semantics.
  async _dispatchReadOnlyBatch(proposal, epoch) {
    const actions = proposal.actions;
    const firstByType = new Map();
    for (const action of actions) {
      if (!firstByType.has(action.type)) firstByType.set(action.type, action);
    }
    const policies = new Map();
    for (const type of firstByType.keys()) {
      const policy = this._evaluateActionPolicy(this._permissionMode, type);
      if (!policy.allowed) return "individual";
      policies.set(type, policy);
    }

    const suffix = ` (batch of ${actions.length} read-only actions)`;
    let decision = { decision: "allow", reasons: [] };
    let reviewDescriptor = null;
    const severity = { allow: 0, review: 1, deny: 2, quarantine: 2 };
    for (const [type, action] of firstByType) {
      const policy = policies.get(type);
      const descriptor = this._describeAction(action, randomUUID(), suffix);
      let next;
      try {
        next = policy.approval === "bypass"
          ? { decision: "allow", reasons: ["explicit_full_permission"] }
          : policy.approval === "human"
            ? { decision: "review", reasons: ["human_confirmation_required"] }
            : await this._approve(descriptor);
      } catch {
        if (this._stopHappenedSince(epoch)) return "stop_loop";
        await this._pauseWith("approver_error");
        return "stop_loop";
      }
      if (this._stopHappenedSince(epoch)) return "stop_loop";
      if ((severity[next.decision] ?? 2) > (severity[decision.decision] ?? 2)) decision = next;
      if (next.decision === "review" && !reviewDescriptor) reviewDescriptor = descriptor;
    }
    decision = await this._applyReviewFallback(decision, actions[0].type);

    if (decision.decision === "review") {
      const descriptor = reviewDescriptor ?? this._describeAction(actions[0], randomUUID(), suffix);
      this._approvalQueue.push({
        id: descriptor.requestId,
        summary: descriptor.summary,
        actionType: actions[0].type,
        createdAt: new Date().toISOString(),
        epoch,
        goalVersion: this._goal.goalVersion,
        expiresAt: this._now() + contracts.APPROVAL_EXPIRY_MS,
        deadline: this._monotonicNow() + contracts.APPROVAL_EXPIRY_MS,
        descriptor,
        action: actions[0],
        actions,
        proposal,
      });
      this._leaveActive();
      this._task = { state: "awaiting_approval", pauseReason: null };
      await this._checkpoint();
      this._emit();
      return "stop_loop";
    }
    if (decision.decision !== "allow") {
      if (this._routineRunner) {
        await this._denyRoutineStep(decision);
        return "stop_loop";
      }
      return "continue";
    }
    return this._runApprovedReadOnlyBatch(proposal, actions, epoch);
  }

  async _runApprovedReadOnlyBatch(proposal, actions, epoch) {
    for (let index = 0; index < actions.length; index += 1) {
      if (this._budgets.actionsUsed >= this._goal.limits.maxActions) {
        await this._pauseWith("budget_exhausted");
        return "stop_loop";
      }
      const pressure = this._memoryMonitor.getPressureLevel();
      if (pressure === "pause" || pressure === "emergency") {
        await this._pauseForMemoryPressure(pressure);
        return "stop_loop";
      }
      // A read-only batch ([find_text, observe]) must not slip past the repeat limits the one-action path enforces.
      const blocked = await this._repeatGuard(actions[index]);
      if (blocked) return blocked;
      const descriptor = this._describeAction(actions[index], randomUUID());
      const dispatched = await this._dispatchApprovedAndApplyTracked(proposal, descriptor, actions[index], epoch, {
        durable: index === actions.length - 1,
      });
      if (dispatched.stale || this._stopHappenedSince(epoch) || this._task.state !== "running") return "stop_loop";
    }
    return "continue";
  }

  // The single commit point: this staleness check runs exactly once,
  // synchronously, as the very first thing here -- before action_started is
  // ever written. Once past it, this function is committed and must run to
  // completion (real execute(), real action_outcome) no matter what happens
  // to the epoch afterward -- it must never retroactively relabel something
  // "cancelled" once action_started may already be durable. A concurrent
  // pause/stop/takeOver instead WAITS for this call's true outcome via
  // _dispatchApprovedAndApplyTracked's entry in _inFlightOps.
  // Waits out the same-site gap before a page load. Runs before action_started so a
  // stop during the wait leaves no open action; returns false if a stop happened.
  async _paceNavigation(action, epoch) {
    if (!["navigate", "follow_link"].includes(action.type) || this._navIntervalMs <= 0) return true;
    let origin = null;
    try { origin = new URL(describeActionTarget(action, this._lastObservation)).origin; } catch { return true; }
    for (;;) {
      const wait = (this._lastNavAt.get(origin) ?? 0) + this._navIntervalMs - Date.now();
      if (wait <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 250)));
      if (this._stopHappenedSince(epoch)) return false;
    }
    this._lastNavAt.set(origin, Date.now());
    return true;
  }

  // The random pause before a click. Runs before action_started, like navigation pacing, so a stop
  // during the wait leaves no open action; returns false if a stop happened.
  async _paceClick(action, epoch) {
    if (!this._clickDelay || (action.type !== "click" && action.type !== "click_at")) return true;
    const seconds = clickDelaySeconds(this._clickDelay.min, this._clickDelay.max, this._random());
    await this._sleep(seconds * 1000);
    return !this._stopHappenedSince(epoch);
  }

  async _dispatchApproved(descriptor, action, epoch, { durable = true, widenedBy = null } = {}) {
    if (this._stopHappenedSince(epoch)) {
      return { status: "not_dispatched", actionId: null, action, descriptor };
    }
    if (!(await this._paceNavigation(action, epoch))) {
      return { status: "not_dispatched", actionId: null, action, descriptor };
    }
    if (!(await this._paceClick(action, epoch))) {
      return { status: "not_dispatched", actionId: null, action, descriptor };
    }
    const actionId = randomUUID();
    // action_started stays durable (default): recovery's execution_uncertain
    // check depends on this specific write being fsync'd before execute()
    // ever runs -- see streamJournalReplay's openActionId handling.
    await this._store.append({ type: "action_started", payload: { actionId } }, { durable });
    let result;
    try {
      // Carry the epoch of the observation the proposal was actually based
      // on, not null: null disables BrowserAdapter.execute()'s stale-
      // document guard outright, letting a follow_link/scroll proposed
      // against a page that has since redirected or navigated act on the
      // wrong document instead of failing closed with stale_document.
      const documentEpoch = this._lastObservation ? this._lastObservation.documentEpoch : null;
      // Native-app actions go to the OS adapter, which applies its own policy before any backend call.
      if (typeof action.type === "string" && action.type.startsWith("os_")) {
        result = !this._osComputerUse ? { status: "failed", errorCode: "os_unavailable" }
          : action.type === "os_observe" ? await this._osComputerUse.observe()
            : await this._osComputerUse.execute(action);
        if (action.type === "os_observe" && result.observation) this._osObservation = result.observation;
      } else {
        result = await this._browser.execute(action, { signal: undefined, documentEpoch, widenedBy });
      }
    } catch {
      // A rejected/timeout response cannot prove that the remote or local
      // browser did not apply the action. Keep action_started open so reload
      // derives execution_uncertain and requires explicit human confirmation
      // instead of making an unsafe retry look like an ordinary failure.
      this._budgets.actionsUsed += 1;
      return { status: "uncertain", errorCode: "execute_threw", actionId, action, descriptor };
    }
    // Count every committed execution regardless of whether ownership
    // changed (resume -> takeover) while it was in flight: action_started,
    // the real execute(), and action_outcome all already happened, so
    // skipping the budget increment here would let repeated takeover during
    // execution perform more real actions than maxActions allows.
    this._budgets.actionsUsed += 1;
    this._lastActionType = action.type;
    this._lastActionStatus = result.status;
    // What the last action did, in the host's words: "ok" alone left a small
    // planner unsure a click had worked, so it repeated the same click.
    if (action.type === "click" || action.type === "click_at") {
      const el = action.type === "click" ? this._lastObservation?.elements?.find((e) => e.elementId === action.elementId) : null;
      const hit = action.type === "click_at" && this._screenTargets ? resolveTarget(this._screenTargets.targets, Number(action.x), Number(action.y)) : null;
      const target = el ? `${el.role} ${JSON.stringify(String(el.name ?? "").slice(0, 60))}` : hit ? `${hit.role} ${JSON.stringify(String(hit.name ?? "").slice(0, 60))}` : null;
      this._lastActionNote = result.status === "ok" ? { type: action.type, target, succeeded: true } : { type: action.type, target, succeeded: false };
    } else {
      this._lastActionNote = undefined;
    }
    // An API reply is kept for the next planner turn and counts as read text, so the checklist can match
    // a value to its source. It is page-derived: the planner is told so and the host never acts on it.
    if (action.type === "http_get" && result.httpGet) {
      this._apiResponse = { ...result.httpGet, text: String(result.httpGet.text ?? "").slice(0, 12000), authority: "untrusted_page_derived" };
      this._observedTexts.delete(result.httpGet.url);
      this._observedTexts.set(result.httpGet.url, String(result.httpGet.text ?? "").slice(0, 20000));
      if (this._observedTexts.size > 40) this._observedTexts.delete(this._observedTexts.keys().next().value);
      if (this._isResearchTask() && result.status === "ok") {
        const ledger = await this._hydrateResearchLedger();
        if (ledger.add({ url: result.httpGet.url, title: "API response", at: Date.now() })) {
          await this._store.append({ type: "note", payload: { kind: "research_source", url: result.httpGet.url, title: "API response", at: Date.now() } });
        }
      }
    } else if (action.type !== "http_get") {
      this._apiResponse = undefined;
    }
    this._easyStreak = result.status === "ok" && ["navigate", "follow_link"].includes(action.type) ? this._easyStreak + 1 : 0;
    // durable:false: the NEXT action_started's own durable append (same
    // loop, common case) or the checkpoint at whatever pause/stop follows
    // this one (rare case) flushes this write before either commits
    // anything that depends on it. Worst case on a real crash right after
    // this line, this outcome simply isn't on disk yet -- recovery then
    // sees an open action_started with no outcome and reports
    // execution_uncertain, the same fail-closed result as today; it never
    // reports success for something that did not durably complete.
    if (process.env.HALO_DEBUG_ACTIONS) {
      if (result.status !== "ok") console.error("[action-fail]", action.type, JSON.stringify(action).slice(0, 200), result.errorCode);
      else if (action.type === "click") {
        const el = this._lastObservation?.elements?.find((e) => e.elementId === action.elementId);
        console.error("[action-ok] click", action.elementId, el ? `${el.role} ${JSON.stringify(el.name)}` : "unknown element");
      } else if (action.type === "click_at" || action.type === "type_at") {
        const hit = this._screenTargets ? resolveTarget(this._screenTargets.targets, Number(action.x), Number(action.y)) : null;
        console.error("[action-ok]", action.type, `(${action.x},${action.y})`, hit ? `${hit.role} ${JSON.stringify(hit.name)}` : "no mapped control");
      }
    }
    await this._store.append({ type: "action_outcome", payload: { actionId, status: result.status } }, { durable: false });
    return { ...result, actionId, action, descriptor };
  }

  async _afterActionDispatched(proposal, result, epoch) {
    // Harness v2 Phase 2 Task 4: only a successful "observe" action leaves a
    // reusable snapshot; any other dispatched action (even read-only ones
    // like scroll) clears it, since this cache's only safety property is
    // "the last thing we dispatched was itself the observation in hand."
    this._reusableObservation = result.action?.type === "observe" && result.status === "ok" && result.observation
      ? result.observation
      : null;

    if (this._repeatFailureLimit > 0 && result.action) {
      const repeatKey = repeatActionKey(result.action);
      if (result.status === "failed" && DETERMINISTIC_FAILURES.has(result.errorCode)) {
        this._repeatFailures.set(repeatKey, (this._repeatFailures.get(repeatKey) ?? 0) + 1);
      } else if (result.status === "ok") {
        this._repeatFailures.delete(repeatKey);
      }
    }

    // Dead ends that are the model's to route around: an element the host will not click, and re-opening the page that is already open.
    if (result.action && !this._repeatFeedback) {
      if (result.status === "failed" && result.errorCode === "unsupported_click") {
        this._repeatFeedback = { note: "unsupported_click", actionType: result.action.type, guidance: "That element cannot be clicked (it is not a link or button). Look for a link or button inside or beside it, or open the page by its URL on the same site; do not retry the same click." };
      } else if (result.action.type === "navigate" && result.status === "ok" && typeof result.action.url === "string") {
        const navKey = result.action.url.replace(/#.*$/, "");
        this._navCounts = this._navCounts ?? new Map();
        const n = (this._navCounts.get(navKey) ?? 0) + 1;
        this._navCounts.set(navKey, n);
        if (n >= 2) this._repeatFeedback = { note: "navigate_repeat", actionType: "navigate", guidance: `You already opened ${navKey.slice(0, 120)} ${n} times. Reloading it shows the same page. Use what you already saw on it (scroll, find_text or follow a link on it), or report the answer you have with its source.` };
      } else if (result.action.type === "find_text" && result.status === "ok" && typeof result.action.text === "string") {
        // A phrase that was already found on this page is already in view: searching it again changes nothing.
        const findKey = `${this._lastObservation?.url ?? ""}::${result.action.text.trim().toLowerCase()}`;
        this._foundTexts = this._foundTexts ?? new Map();
        const n = (this._foundTexts.get(findKey) ?? 0) + 1;
        this._foundTexts.set(findKey, n);
        if (n >= 2) this._repeatFeedback = { note: "find_text_repeat", actionType: "find_text", guidance: `"${result.action.text.slice(0, 80)}" was already found and scrolled into view on this page ${n} times; searching it again shows the same thing. If the page now shows what the request asked for, report it (need_user with the answer and this page as its source); otherwise follow a link or button there instead of searching again.` };
      }
    }

    if (this._repeatFailureLimit > 0 && result.action) {
      this._familyWindow.push(actionFamily(result.action));
      if (this._familyWindow.length > FAMILY_WINDOW) this._familyWindow.shift();
      const family = actionFamily(result.action);
      if (family && this._familyWindow.filter((f) => f === family).length === FAMILY_WARN && !this._repeatFeedback) {
        this._repeatFeedback = {
          note: "repeat_family",
          actionType: result.action.type,
          guidance: `You have used ${family} ${FAMILY_WARN} times in the last few actions. If it is not getting you further, change approach now instead of trying another variant.`,
        };
      }
    }

    if (result.action?.type === "find_text" && typeof result.action.text === "string") {
      this._textFocusQueries = [...this._textFocusQueries.filter((q) => q !== result.action.text), result.action.text.slice(0, 200)].slice(-4);
    }

    // Scrolling the same page again and again is a loop even when each scroll
    // reveals slightly different text (so the identical-observation key below
    // never repeats): pause instead of burning the whole time budget on it.
    if (result.action?.type === "scroll") {
      const url = this._lastObservation?.url ?? null;
      this._scrollStreak = url !== null && url === this._scrollStreak.url
        ? { url, count: this._scrollStreak.count + 1 }
        : { url, count: 1 };
      if (this._scrollStreak.count >= SCROLL_STREAK_LIMIT) {
        if (await this._tryRecover("no_progress", "scroll-warning")) {
          this._scrollStreak = { url: null, count: 0 };
          this._loopHint = true;
          return;
        }
        await this._store.append({ type: "note", payload: { msg: "repeated scrolling on one page; pausing" } });
        await this._pauseWith("no_progress");
        return;
      }
    } else {
      this._scrollStreak = { url: null, count: 0 };
    }

    // No-progress detection: 3 consecutive dispatches of the identical
    // (action, observation) pair with no newly-verified criterion earns one
    // free forced replan; a second such streak pauses no_progress (design
    // doc section 5).
    const key = `${JSON.stringify(result.action)}::${observationKey(this._lastObservation)}`;
    let madeProgress = false;

    if (result.evidenceCandidate) {
      for (const criterionId of proposal.criterionIds) {
        const criterion = this._goal.criteria.find((c) => c.id === criterionId);
        if (!criterion) continue;
        const candidateEvidence = {
          id: randomUUID(),
          taskId: this._goal.taskId,
          goalVersion: this._goal.goalVersion,
          criterionId,
          kind: result.evidenceCandidate.kind || "host_check",
          observationId: result.evidenceCandidate.observationId,
          sourceUrl: result.evidenceCandidate.sourceUrl,
          artifactHash: result.evidenceCandidate.artifactHash,
          at: new Date().toISOString(),
          verification: "pending",
        };
        const verdict = verifyCriterion(criterion, [candidateEvidence], this._hostVerifier);
        const finalEvidence = { ...candidateEvidence };
        if (verdict.status !== "pending") {
          finalEvidence.verification = verdict.status;
          finalEvidence.verifierId = "host";
        }
        // durable:false, same reasoning as action_outcome above: this is
        // still inside the autonomous per-action hot path (right after
        // action_outcome, before this._criteriaStatus.set() below), and the
        // next action_started or the checkpoint before any pause/stop
        // flushes it. checkpoint()'s own flush-before-snapshot ordering is
        // exactly what keeps a checkpointed criteriaStatus from ever
        // outrunning the evidence record that justified it.
        await this._store.append({ type: "evidence_recorded", payload: { evidence: finalEvidence } }, { durable: false });
        const previous = this._criteriaStatus.get(criterionId);
        this._criteriaStatus.set(criterionId, {
          status: verdict.status,
          evidenceId: finalEvidence.id,
          goalVersion: finalEvidence.goalVersion,
        });
        if (verdict.status === "verified" && (!previous || previous.status !== "verified" || previous.goalVersion !== finalEvidence.goalVersion)) {
          madeProgress = true;
        }
      }
    }

    if (madeProgress) {
      this._recovery.noteProgress();
      this._noProgress = { lastKey: null, consecutive: 0, hasReplannedOnce: false };
      return;
    }

    // Different actions on a page that never changes (a blank or error page, the same results) evade the identical-action key above
    // and each one costs a full planning call: stop that stall on its own, after one recovery attempt.
    const pageKey = observationKey(this._lastObservation);
    this._pageStall = pageKey === this._pageStall?.key ? { key: pageKey, count: this._pageStall.count + 1 } : { key: pageKey, count: 1 };
    if (this._pageStallLimit > 0 && this._pageStall.count >= this._pageStallLimit) {
      this._pageStall = { key: pageKey, count: 0 };
      await this._store.append({ type: "note", payload: { msg: "page unchanged across many actions; recovering or pausing" } });
      if (await this._tryRecover("no_progress", "page-stall")) { this._loopHint = true; return; }
      await this._pauseWith("no_progress");
      return;
    }

    if (key === this._noProgress.lastKey) {
      this._noProgress.consecutive += 1;
    } else {
      this._noProgress = { lastKey: key, consecutive: 1, hasReplannedOnce: this._noProgress.hasReplannedOnce };
    }

    if (this._noProgress.consecutive >= this._noProgressThreshold) {
      if (!this._noProgress.hasReplannedOnce) {
        this._noProgress = { lastKey: key, consecutive: 0, hasReplannedOnce: true };
        await this._store.append({ type: "note", payload: { msg: "no-progress streak detected; forcing one replan" } });
      } else if (await this._tryRecover("no_progress", "repeat-warning")) {
        this._noProgress = { lastKey: key, consecutive: 0, hasReplannedOnce: true };
        this._loopHint = true;
      } else {
        await this._pauseWith("no_progress");
      }
    }
  }
}

// Errors that repeat identically when the same action is run again (the page or target is what is wrong).
const DETERMINISTIC_FAILURES = new Set(["navigation_error", "option_not_found", "element_not_found", "locator_not_found", "locator_ambiguous", "not_checkable", "text_not_found", "http_get_not_allowed", "http_get_content_type", "invalid_http_get", "os_denied", "os_unavailable", "invalid_os_action", "os_stopped"]);
const REPEAT_BLOCK_PAUSE = 3;
// Consecutive dispatches that leave the observed page identical, whatever the actions were.
const PAGE_STALL_LIMIT = 10;
// A kind of action that tends to loop. type is not one: a long form legitimately types many fields.
const FAMILY_WINDOW = 12;
const FAMILY_WARN = 3;
const FAMILY_BLOCK = 5;
function actionFamily(action) {
  if (action?.type === "find_text") return "find_text";
  if (action?.type === "submit_form") return "submit_form";
  return null;
}
// Same action, ignoring the per-observation/per-request ids that change every turn.
function repeatActionKey(action) {
  const { observationId, requestId, id, actionId, ...rest } = action ?? {};
  return JSON.stringify(rest, Object.keys(rest).sort());
}

module.exports = { TaskController, TaskControllerError };
