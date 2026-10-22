"use strict";

// Reconstructs a planner's entire input from host-owned sources every call
// (design doc section 5, "컨텍스트 교체와 목표 이탈 방지"). This is the one
// place a model summary, a page's claims, or a stale in-process cache could
// smuggle a rewritten goal past the host -- so this function only ever
// copies the trusted `goal`/`state` inputs verbatim into their own fields;
// an optional `state.modelSummary` is echoed back tagged as
// `untrustedSummary` and is never merged into `goal` or `progress`.
//
// Memory discipline (design doc section 10): this function never
// accumulates history itself. `recentEvents` is bounded to the most recent
// MAX_RECENT_EVENTS_IN_CONTEXT regardless of how many were passed in, and
// the whole assembled packet is checked against MAX_CONTEXT_PACKET_BYTES.
// If it doesn't fit, nothing is truncated -- the goal text and criteria are
// never cut short to make room; the caller gets a context_limit error and
// must pause rather than silently ship a lossy goal to the planner.


type PlainRecord = Record<string, unknown>;
interface GoalSpec {
  taskId: string; goalVersion: number; originalRequest: string;
  amendments: unknown[]; constraints: unknown[]; criteria: unknown[];
}
interface WorkGoalBinding { goalId: string; goalVersion: number; reservationId: string }
interface WorkGoal {
  goalId: string; goalVersion: number; objective: string;
  successCriteria: Array<{ id: string; [key: string]: unknown }>;
  verifiedCriterionIds: string[]; remainingBudget: Record<string, number>;
}
interface BoardNote { from: string; kind: string; text: string; at?: unknown }
interface TeamBoard { parentTaskId: string; entries: BoardNote[] }
interface ContextRef {
  refId: string; kind: string; authority: string; revision: string;
  byteLength: number; summary: string; [key: string]: unknown;
}
interface ContextManifest { version: number; refs: ContextRef[] }
interface Navigation { visited: unknown[]; frontier: unknown[] }
interface ContextInput {
  goal: GoalSpec; state: unknown; observation?: unknown; recentEvents: unknown[];
  customMemory?: unknown[]; pendingMessages?: unknown[]; navigation?: Navigation | null;
  workGoalBinding?: WorkGoalBinding; workGoal?: WorkGoal;
  teamBoard?: TeamBoard | null; contextManifest?: ContextManifest;
  strategyGuidance?: string | null;
  // When set (even empty), long page text is cut down to the passages that share words with the goal or these find_text queries.
  textFocusQueries?: string[] | null;
}
interface Contracts {
  isPlainObject(value: unknown): value is PlainRecord;
  validateGoalSpec(value: unknown, label: string): void;
  assertUuid(value: unknown, label: string): void;
  MAX_RECENT_EVENTS_IN_CONTEXT: number; MAX_CONTEXT_PACKET_BYTES: number;
  MAX_MESSAGES_PER_TURN: number; MAX_MESSAGE_TURN_CONTEXT_BYTES: number;
}

const contracts: Contracts = require("../../shared/harness-contracts");
const workGoalContracts: { MAX_BUDGET: Record<string, number>; validateWorkGoalInput(value: unknown): void } = require("../../shared/work-goal-contracts");
const { validateWorkGoalBinding } = require("../../shared/task-profile-contracts") as { validateWorkGoalBinding(value: unknown): void };
const { selectBuiltinPlaybooks } = require("./skill-library") as { selectBuiltinPlaybooks(goal: GoalSpec): unknown };
const { derivePlannerAdaptation } = require("./planner-adaptation") as { derivePlannerAdaptation(input: { goal: GoalSpec; state: PlainRecord; observation: unknown; customMemory: unknown[] }): unknown };

const WORK_GOAL_CONTEXT_FIELDS = Object.freeze([
  "goalId", "goalVersion", "objective", "successCriteria", "verifiedCriterionIds", "remainingBudget",
]);
const WORK_GOAL_BUDGET_FIELDS = Object.freeze(Object.keys(workGoalContracts.MAX_BUDGET));

class ContextError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ContextError";
    this.code = code;
  }
}

function validatedWorkGoalContext(workGoalBinding: WorkGoalBinding | undefined, workGoal: WorkGoal | undefined) {
  if (workGoalBinding === undefined && workGoal === undefined) return undefined;
  if (workGoalBinding === undefined || workGoal === undefined) {
    throw new ContextError("invalid_field", "bound Work Goal context requires both binding and content");
  }
  try {
    validateWorkGoalBinding(workGoalBinding);
    if (!contracts.isPlainObject(workGoal) ||
        WORK_GOAL_CONTEXT_FIELDS.some((field) => !Object.hasOwn(workGoal, field)) ||
        Object.keys(workGoal).some((field) => !WORK_GOAL_CONTEXT_FIELDS.includes(field))) {
      throw new Error("Work Goal context has an invalid shape");
    }
    contracts.assertUuid(workGoal.goalId, "workGoal.goalId");
    if (!Number.isSafeInteger(workGoal.goalVersion) || workGoal.goalVersion <= 0 ||
        workGoal.goalId !== workGoalBinding.goalId || workGoal.goalVersion !== workGoalBinding.goalVersion) {
      throw new Error("Work Goal context does not match the Task binding");
    }
    workGoalContracts.validateWorkGoalInput({
      objective: workGoal.objective,
      successCriteria: workGoal.successCriteria,
    });
    if (!Array.isArray(workGoal.verifiedCriterionIds)) throw new Error("verifiedCriterionIds must be an array");
    const criterionIds = new Set(workGoal.successCriteria.map((criterion) => criterion.id));
    const verified = new Set();
    for (const id of workGoal.verifiedCriterionIds) {
      if (!criterionIds.has(id) || verified.has(id)) throw new Error("verifiedCriterionIds contains an unknown or duplicate ID");
      verified.add(id);
    }
    if (!contracts.isPlainObject(workGoal.remainingBudget)) throw new Error("remainingBudget must be an object");
    for (const [field, amount] of Object.entries(workGoal.remainingBudget)) {
      if (!WORK_GOAL_BUDGET_FIELDS.includes(field) || !Number.isSafeInteger(amount) ||
          amount < 0 || amount > workGoalContracts.MAX_BUDGET[field]) {
        throw new Error("remainingBudget contains an invalid amount");
      }
    }
  } catch (error) {
    throw new ContextError("invalid_field", `invalid bound Work Goal context: ${(error as Error).message}`);
  }
  // Take an independent snapshot: the caller can update its authoritative
  // state after this turn, but cannot mutate a packet already handed to the
  // planner through a shared nested object reference.
  return {
    goalId: workGoal.goalId,
    goalVersion: workGoal.goalVersion,
    objective: workGoal.objective,
    successCriteria: workGoal.successCriteria.map((criterion) => ({ ...criterion })),
    verifiedCriterionIds: [...workGoal.verifiedCriterionIds],
    remainingBudget: { ...workGoal.remainingBudget },
  };
}

// A child's team board (ChildAgentCoordinator.readTeamBoard): siblings'
// notes, newest kept, within its own byte budget and the packet ceiling,
// after pending messages (which come from the parent and matter more).
const MAX_BOARD_CONTEXT_BYTES = 8 * 1024;

function validTeamBoard(teamBoard: TeamBoard | null | undefined) {
  if (teamBoard === undefined || teamBoard === null) return null;
  if (!contracts.isPlainObject(teamBoard) || !Array.isArray(teamBoard.entries) || typeof teamBoard.parentTaskId !== "string"
    || !teamBoard.entries.every((e) => contracts.isPlainObject(e) && typeof e.text === "string" && typeof e.from === "string" && typeof e.kind === "string")) {
    throw new ContextError("invalid_field", "teamBoard must be { parentTaskId, entries: [{from, kind, text, at}] }");
  }
  return teamBoard;
}

// P1 (2026-10-02 harness efficiency design, section 5): an opt-in list of
// host-owned references the planner may read with a context_read action. Only
// ids, labels, sizes and short summaries travel in the packet; bodies do not.
const MAX_MANIFEST_CONTEXT_BYTES = 8 * 1024;

function validContextManifest(manifest: ContextManifest | undefined) {
  if (manifest === undefined) return undefined;
  if (!contracts.isPlainObject(manifest) || manifest.version !== 1 || !Array.isArray(manifest.refs) || manifest.refs.length > 128
    || !manifest.refs.every((r) => contracts.isPlainObject(r) && typeof r.refId === "string" && typeof r.kind === "string"
      && typeof r.authority === "string" && typeof r.revision === "string" && Number.isInteger(r.byteLength) && typeof r.summary === "string")) {
    throw new ContextError("invalid_field", "contextManifest must be { version: 1, refs: [{refId, kind, authority, revision, byteLength, summary}] }");
  }
  // The catalog may hold 128 refs; the packet shows only the newest that fit
  // in MAX_MANIFEST_CONTEXT_BYTES and says how many it left out.
  const kept: ContextRef[] = [];
  for (const ref of [...manifest.refs].reverse()) {
    const candidate = { version: 1, refs: [ref, ...kept], omittedRefs: manifest.refs.length - kept.length - 1 };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > MAX_MANIFEST_CONTEXT_BYTES) break;
    kept.unshift(ref);
  }
  return { version: 1, refs: kept, omittedRefs: manifest.refs.length - kept.length };
}

// Same page, fewer bytes: a null parent says nothing the missing field does not, and a link repeated with the same
// label and address (a logo, a menu shown twice) only needs to be offered once. Applied to what the planner is sent,
// never to what the host acts on.
function compactObservation(observation: unknown): unknown {
  if (!contracts.isPlainObject(observation) || !Array.isArray(observation.elements)) return observation;
  const seenLinks = new Set<string>();
  const elements: unknown[] = [];
  for (const element of observation.elements as unknown[]) {
    if (!contracts.isPlainObject(element)) { elements.push(element); continue; }
    if (element.role === "link" && typeof element.href === "string") {
      const key = `${element.name}\u0000${element.href}`;
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
    }
    if (element.parentElementId === null) { const { parentElementId, ...rest } = element; elements.push(rest); } else elements.push(element);
  }
  const compacted = dropEmptyContainers(elements);
  return { ...observation, elements: SLIM ? dropMirroredContainers(compacted.map(withCleanHref)) : compacted };
}

// HALO_CTX_SLIM=1: three more byte savings that change nothing the planner can act on. Tracking query parameters come off
// links (never truncated, so a copied URL still works), a named container whose only child repeats its name is folded into
// that child, and navigationHistory keeps the latest visits and the first few frontier links.
const SLIM_LEVEL = Number(process.env.HALO_CTX_SLIM) || 0;
const SLIM = SLIM_LEVEL >= 1;
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|msclkid$|mc_[a-z]+$)/i;
function cleanUrl(href: string): string {
  if (typeof href !== "string" || !href.includes("?")) return href;
  try {
    const url = new URL(href);
    for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return href; }
}
function withCleanHref(element: unknown): unknown {
  return contracts.isPlainObject(element) && typeof element.href === "string" ? { ...element, href: cleanUrl(element.href) } : element;
}
function dropMirroredContainers(elements: unknown[]): unknown[] {
  const children = new Map<string, PlainRecord[]>();
  for (const e of elements) if (contracts.isPlainObject(e) && typeof e.parentElementId === "string") {
    const list = children.get(e.parentElementId);
    if (list) list.push(e); else children.set(e.parentElementId, [e]);
  }
  const parentOf = new Map<string, unknown>();
  const dropped = new Set<string>();
  for (const e of elements) {
    if (!contracts.isPlainObject(e) || typeof e.elementId !== "string") continue;
    parentOf.set(e.elementId, e.parentElementId ?? null);
    const only = children.get(e.elementId);
    if (EMPTY_CONTAINER_ROLES.has(e.role as string) && typeof e.name === "string" && e.name !== "" && e.href === undefined && only?.length === 1 &&
      typeof only[0].name === "string" && only[0].name.toLowerCase() === e.name.toLowerCase()) dropped.add(e.elementId);
  }
  if (dropped.size === 0) return elements;
  const keptAncestor = (id: unknown): unknown => {
    for (let guard = 0; typeof id === "string" && dropped.has(id) && guard < 10000; guard++) id = parentOf.get(id) ?? null;
    return id ?? null;
  };
  const out: unknown[] = [];
  for (const e of elements) {
    if (contracts.isPlainObject(e) && typeof e.elementId === "string" && dropped.has(e.elementId)) continue;
    if (contracts.isPlainObject(e) && typeof e.parentElementId === "string" && dropped.has(e.parentElementId)) {
      const parent = keptAncestor(e.parentElementId);
      const { parentElementId, ...rest } = e;
      out.push(parent === null ? rest : { ...rest, parentElementId: parent });
    } else out.push(e);
  }
  return out;
}

// A row/cell/list/listitem with no name and nothing else to act on says nothing the tree below it does not; its
// children are re-parented to the nearest kept ancestor so the structure of what can be acted on is unchanged.
const EMPTY_CONTAINER_ROLES = new Set(["row", "cell", "list", "listitem", "generic", "group", "rowgroup", "none", "presentation"]);
function dropEmptyContainers(elements: unknown[]): unknown[] {
  const droppable = (e: unknown): e is Record<string, unknown> =>
    contracts.isPlainObject(e) && typeof e.role === "string" && EMPTY_CONTAINER_ROLES.has(e.role) && (e.name === "" || e.name === undefined) &&
    Object.keys(e).every((k) => k === "role" || k === "name" || k === "elementId" || k === "parentElementId");
  const parentOf = new Map<string, unknown>();
  const dropped = new Set<string>();
  for (const e of elements) {
    if (contracts.isPlainObject(e) && typeof e.elementId === "string") parentOf.set(e.elementId, e.parentElementId ?? null);
    if (droppable(e) && typeof e.elementId === "string") dropped.add(e.elementId);
  }
  if (dropped.size === 0) return elements;
  const keptAncestor = (id: unknown): unknown => {
    for (let guard = 0; typeof id === "string" && dropped.has(id) && guard < 10000; guard++) id = parentOf.get(id) ?? null;
    return id ?? null;
  };
  const out: unknown[] = [];
  for (const e of elements) {
    if (contracts.isPlainObject(e) && typeof e.elementId === "string" && dropped.has(e.elementId)) continue;
    if (contracts.isPlainObject(e) && typeof e.parentElementId === "string" && dropped.has(e.parentElementId)) {
      const parent = keptAncestor(e.parentElementId);
      const { parentElementId, ...rest } = e;
      out.push(parent === null ? rest : { ...rest, parentElementId: parent });
    } else out.push(e);
  }
  return out;
}

// Page text is the swing factor in what the planner is sent (3 KB to 30 KB). Above FOCUS_MIN_BYTES, passages that share no
// word with the goal or with a recent find_text query (and are not next to one that does) are replaced by one marker per
// omitted run. Nothing is lost for good: a find_text query adds its words to the focus, so the passage comes back on the
// next observation. The host's own view of the page is untouched.
const FOCUS_MIN_BYTES = 6 * 1024;
const FOCUS_CHUNK_CHARS = 320;
const FOCUS_STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "what", "which", "who", "how", "are", "was", "were", "has", "have", "can", "you", "your", "please", "find", "show", "give", "get", "tell", "all", "any", "not", "its", "their", "there", "about", "page", "site", "website", "web", "search", "look", "check", "using", "use"]);
function focusTerms(...texts: Array<string | undefined>): string[] {
  const terms = new Set<string>();
  for (const text of texts) {
    for (const word of String(text ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      const ascii = /^[\x00-\x7f]+$/.test(word);
      if (word.length < (ascii ? 3 : 2) || FOCUS_STOP.has(word)) continue;
      terms.add(word);
    }
  }
  return [...terms];
}
function focusObservationText(observation: unknown, originalRequest: string, queries: string[] | null | undefined): unknown {
  if (!queries || !contracts.isPlainObject(observation) || typeof observation.text !== "string") return observation;
  const text = observation.text;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes < FOCUS_MIN_BYTES) return observation;
  const terms = focusTerms(originalRequest, ...queries);
  if (terms.length === 0) return observation;
  const chunks: string[] = [];
  for (let at = 0; at < text.length;) {
    let end = Math.min(text.length, at + FOCUS_CHUNK_CHARS);
    if (end < text.length) { const space = text.lastIndexOf(" ", end); if (space > at) end = space; }
    chunks.push(text.slice(at, end)); at = end;
  }
  // A word found in a quarter of the passages (the page's own subject) does not tell passages apart; only rarer ones count.
  const lowered = chunks.map((c) => c.toLowerCase());
  const discriminating = terms.filter((t) => { const n = lowered.filter((c) => c.includes(t)).length; return n >= 1 && n <= Math.max(2, chunks.length * 0.25); });
  if (discriminating.length === 0) return observation;
  const hit = lowered.map((c) => discriminating.some((t) => c.includes(t)));
  const keep = chunks.map((_, i) => i === 0 || hit[i] || hit[i - 1] === true || hit[i + 1] === true);
  const parts: string[] = [];
  let omittedBytes = 0, kept = 0;
  const flush = () => { if (omittedBytes > 0) { parts.push(`[... ${omittedBytes} bytes of page text not shown: no passage words match the goal; find_text with words from it brings it back ...]`); omittedBytes = 0; } };
  chunks.forEach((c, i) => { if (keep[i]) { flush(); parts.push(c); kept += Buffer.byteLength(c, "utf8"); } else omittedBytes += Buffer.byteLength(c, "utf8"); });
  flush();
  if (kept >= bytes * 0.85) return observation;
  return { ...observation, text: parts.join(" ") };
}

// HALO_CTX_SLIM=2: above ELEMENT_FOCUS_MIN elements, keep the form controls (capped), every element whose name or address
// shares a word with the goal or a recent find_text query, and the first ELEMENT_HEAD of the page; the rest are replaced by
// a count. Like the page text focus, a find_text query adds its words to the focus, so an omitted element comes back on the
// next observation. Kept elements whose parent was left out are re-parented to the nearest kept ancestor.
const ELEMENT_FOCUS_MIN = 40;
const ELEMENT_HEAD = 15;
const ELEMENT_CONTROL_CAP = 25;
const CONTROL_ROLES = new Set(["button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "option", "tab", "menuitemcheckbox", "menuitemradio", "listbox"]);
function focusObservationElements(observation: unknown, originalRequest: string, queries: string[] | null | undefined): unknown {
  if (SLIM_LEVEL < 2 || !contracts.isPlainObject(observation) || !Array.isArray(observation.elements) || observation.elements.length <= ELEMENT_FOCUS_MIN) return observation;
  const terms = focusTerms(originalRequest, ...(queries ?? []));
  const elements = observation.elements as unknown[];
  const keep = new Array<boolean>(elements.length).fill(false);
  let controls = 0;
  elements.forEach((e, i) => {
    if (!contracts.isPlainObject(e)) return void (keep[i] = true);
    const haystack = `${e.name ?? ""} ${e.href ?? ""}`.toLowerCase();
    if (i < ELEMENT_HEAD || terms.some((t) => haystack.includes(t))) keep[i] = true;
    else if (CONTROL_ROLES.has(e.role as string) && controls < ELEMENT_CONTROL_CAP) { controls++; keep[i] = true; }
  });
  const kept = elements.filter((_, i) => keep[i]);
  const omitted = elements.length - kept.length;
  if (omitted < 10) return observation;
  const parentOf = new Map<unknown, unknown>(elements.map((e) => [(e as PlainRecord | undefined)?.elementId, (e as PlainRecord | undefined)?.parentElementId ?? null]));
  const keptIds = new Set<unknown>(kept.map((e) => (e as PlainRecord | undefined)?.elementId));
  const ancestor = (id: unknown): unknown => {
    for (let guard = 0; typeof id === "string" && !keptIds.has(id) && guard < 10000; guard++) id = parentOf.get(id) ?? null;
    return id ?? null;
  };
  const out = kept.map((e) => {
    if (!contracts.isPlainObject(e) || typeof e.parentElementId !== "string" || keptIds.has(e.parentElementId)) return e;
    const parent = ancestor(e.parentElementId);
    const { parentElementId, ...rest } = e;
    return parent === null ? rest : { ...rest, parentElementId: parent };
  });
  return { ...observation, elements: out, elementsNotShown: omitted };
}

function buildContext({ goal, state, observation, recentEvents, customMemory = [], pendingMessages = [], navigation = null, workGoalBinding, workGoal, teamBoard, contextManifest, strategyGuidance, textFocusQueries }: ContextInput) {
  contracts.validateGoalSpec(goal, "goal"); // defense in depth; callers should already hold a validated goal

  if (!contracts.isPlainObject(state)) {
    throw new ContextError("invalid_field", "state must be a plain object");
  }
  if (!Array.isArray(recentEvents)) {
    throw new ContextError("invalid_field", "recentEvents must be an array");
  }
  if (!Array.isArray(customMemory)) {
    throw new ContextError("invalid_field", "customMemory must be an array");
  }
  if (!Array.isArray(pendingMessages)) {
    throw new ContextError("invalid_field", "pendingMessages must be an array");
  }

  const board = validTeamBoard(teamBoard);
  const manifest = validContextManifest(contextManifest);

  if (navigation !== null && (!contracts.isPlainObject(navigation) || !Array.isArray(navigation.visited) || !Array.isArray(navigation.frontier))) {
    throw new ContextError("invalid_field", "navigation must be null or { visited: [], frontier: [] }");
  }

  const { modelSummary, ...trustedProgress } = state;
  const boundedRecentEvents = recentEvents.slice(-contracts.MAX_RECENT_EVENTS_IN_CONTEXT);
  const boundWorkGoal = validatedWorkGoalContext(workGoalBinding, workGoal);
  const builtinPlaybooks = selectBuiltinPlaybooks(goal);

  const basePacket = {
    taskId: goal.taskId,
    goalVersion: goal.goalVersion,
    goal: {
      originalRequest: goal.originalRequest,
      amendments: goal.amendments,
      constraints: goal.constraints,
      criteria: goal.criteria,
    },
    progress: trustedProgress,
    recentEvents: boundedRecentEvents,
    observation: observation === undefined ? null : focusObservationElements(focusObservationText(compactObservation(observation), goal.originalRequest, textFocusQueries), goal.originalRequest, textFocusQueries),
    untrustedSummary: modelSummary === undefined ? null : { text: modelSummary, authority: "untrusted_summary" },
    userMemory: { authority: "untrusted_user_memory", entries: customMemory },
    ...(builtinPlaybooks === undefined ? {} : { haloPlaybooks: builtinPlaybooks }),
    // Host-recorded, but every URL/name originated in a page the browser
    // loaded, so it is data to consider, never an instruction.
    navigationHistory: navigation === null ? null : SLIM
      ? { authority: "untrusted_page_derived", visited: navigation.visited.slice(-4), frontier: navigation.frontier.slice(0, 6).map((link) => contracts.isPlainObject(link) ? withCleanHref(link) : link) }
      : { authority: "untrusted_page_derived", visited: navigation.visited, frontier: navigation.frontier },
    pendingMessages: [],
    ...(boundWorkGoal === undefined ? {} : { workGoal: boundWorkGoal }),
    ...(manifest === undefined ? {} : { contextManifest: manifest }),
  };

  const baseSize = Buffer.byteLength(JSON.stringify(basePacket), "utf8");
  if (baseSize > contracts.MAX_CONTEXT_PACKET_BYTES) {
    throw new ContextError("context_limit", `context packet is ${baseSize} bytes, exceeds ${contracts.MAX_CONTEXT_PACKET_BYTES}`);
  }

  // Subagent communication protocol section 8.1: admit a deterministic,
  // ordered prefix of eligible pending messages, subject to a per-turn count
  // cap, a serialized-message-bytes cap, AND the pre-existing total packet
  // ceiling -- whichever is hit first. A message-budget collision never
  // becomes a context_error/pause: if nothing fits, admit none and leave
  // every pending message pending for a later turn (never truncated or
  // summarized away).
  const admitted: unknown[] = [];
  let messageBytes = 0;
  for (const message of pendingMessages) {
    if (admitted.length >= contracts.MAX_MESSAGES_PER_TURN) break;
    const candidateBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (messageBytes + candidateBytes > contracts.MAX_MESSAGE_TURN_CONTEXT_BYTES) break;
    // baseSize already includes the empty [] delimiters. Filling that array
    // adds serialized bodies plus one ASCII comma between each pair; no
    // other packet field changes. Count UTF-8 bytes, never JS code units.
    const candidateSize = baseSize + messageBytes + candidateBytes + admitted.length;
    if (candidateSize > contracts.MAX_CONTEXT_PACKET_BYTES) break;
    admitted.push(message);
    messageBytes += candidateBytes;
  }

  const packet = { ...basePacket, pendingMessages: admitted };
  // Optional style metadata gets space only after goal, observations, and
  // incoming messages. Personalization must never turn a fitting task into a
  // context_error or displace communication that the planner needs to consume.
  const adapt = <T extends object>(input: T) => {
    const plannerAdaptation = derivePlannerAdaptation({ goal, state: trustedProgress, observation, customMemory });
    const base = { ...input, plannerAdaptation };
    const candidate = typeof strategyGuidance === "string" && strategyGuidance.length <= 4096
      ? { ...base, learnedStrategyGuidance: { authority: "host_advisory", text: strategyGuidance } }
      : base;
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= contracts.MAX_CONTEXT_PACKET_BYTES) return candidate;
    // Optional learned hints never make an otherwise valid planner packet fail.
    return Buffer.byteLength(JSON.stringify(base), "utf8") <= contracts.MAX_CONTEXT_PACKET_BYTES ? base : input;
  };
  if (!board) return adapt(packet);
  const notes: BoardNote[] = [];
  let noteBytes = 0;
  for (const entry of [...board.entries].reverse()) {
    const note = { from: entry.from, kind: entry.kind, text: entry.text, ...(typeof entry.at === "string" ? { at: entry.at } : {}) };
    const bytes = Buffer.byteLength(JSON.stringify(note), "utf8");
    if (noteBytes + bytes > MAX_BOARD_CONTEXT_BYTES) break;
    const candidate = { ...packet, teamBoard: { authority: "untrusted_sibling_notes", parentTaskId: board.parentTaskId, entries: [note, ...notes] } };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > contracts.MAX_CONTEXT_PACKET_BYTES) break;
    notes.unshift(note);
    noteBytes += bytes;
  }
  return adapt({ ...packet, teamBoard: { authority: "untrusted_sibling_notes", parentTaskId: board.parentTaskId, entries: notes } });
}

export = { ContextError, buildContext, compactObservation, focusObservationElements };
