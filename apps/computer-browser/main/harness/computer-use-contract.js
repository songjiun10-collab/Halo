"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_VIEWPORT_DIMENSION = 8192;
// Navigation/editing keys only: no modifiers, no function keys, no shortcuts.
const ALLOWED_KEYS = Object.freeze(["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COORDINATE_ACTION_KEYS = Object.freeze({
  click_at: ["type", "observationId", "x", "y"],
  type_at: ["type", "observationId", "x", "y", "text"],
  press_key: ["type", "observationId", "key"],
  play_loop: ["type", "observationId", "seconds", "lanes"],
});
// play_loop (reflex-loop.js): letters, digits and arrows only. Enter, Space, Tab and the rest can activate whatever
// control has focus (a Buy button), so a rule that presses keys for a minute never gets them.
const PLAY_KEYS = Object.freeze([..."abcdefghijklmnopqrstuvwxyz0123456789", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
const MAX_PLAY_SECONDS = 60;
const MAX_PLAY_LANES = 8;
const LANE_KEYS = Object.freeze(["x", "y", "key", "color", "tolerance"]);

class ComputerUseContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ComputerUseContractError";
    this.code = code;
  }
}

function validateScreenshotCapture({ png, taskId, agentId, observation, viewport, capturedAt } = {}) {
  const invalid = (message) => { throw new ComputerUseContractError("invalid_visual_observation", message); };
  if (!Buffer.isBuffer(png) || png.length < 8 || png.length > MAX_SCREENSHOT_BYTES ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    invalid("screenshot must be a bounded PNG image");
  }
  if (typeof taskId !== "string" || !UUID_RE.test(taskId)) invalid("taskId must be a host task UUID");
  if (agentId !== null && agentId !== undefined && (typeof agentId !== "string" || !UUID_RE.test(agentId))) {
    invalid("agentId must be a host Agent UUID or null");
  }
  if (!observation || typeof observation !== "object" || Array.isArray(observation) ||
      typeof observation.id !== "string" || observation.id.length < 1 || observation.id.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(observation.id) ||
      !Number.isSafeInteger(observation.documentEpoch) || observation.documentEpoch < 0 ||
      typeof observation.url !== "string") {
    invalid("observation must carry a bounded id, epoch, and URL");
  }
  let parsed;
  try { parsed = new URL(observation.url); } catch { invalid("observation URL is invalid"); }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    invalid("observation must use a credential-free HTTP(S) URL");
  }
  if (!viewport || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) ||
      viewport.width < 1 || viewport.height < 1 || viewport.width > MAX_VIEWPORT_DIMENSION || viewport.height > MAX_VIEWPORT_DIMENSION) {
    invalid("viewport dimensions are invalid");
  }
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) invalid("capturedAt must be a non-negative integer");
  return {
    png,
    taskId,
    agentId: agentId ?? null,
    observationId: observation.id,
    documentEpoch: observation.documentEpoch,
    origin: parsed.origin,
    capturedAt,
    viewport: { width: viewport.width, height: viewport.height },
  };
}

function validateCoordinateAction(action) {
  const invalid = () => { throw new ComputerUseContractError("invalid_coordinate_action", "coordinate action does not match the bounded v1 contract"); };
  if (!action || typeof action !== "object" || Array.isArray(action) || Object.getPrototypeOf(action) !== Object.prototype) invalid();
  const keys = COORDINATE_ACTION_KEYS[action.type];
  if (!keys || Object.keys(action).length !== keys.length || Object.keys(action).some((key) => !keys.includes(key)) || keys.some((key) => !Object.hasOwn(action, key))) invalid();
  if (typeof action.observationId !== "string" || action.observationId.length < 1 || action.observationId.length > 128 || /[\u0000-\u001f\u007f]/.test(action.observationId)) invalid();
  if (action.type === "press_key") {
    if (!ALLOWED_KEYS.includes(action.key)) invalid();
    return action;
  }
  if (action.type === "play_loop") {
    if (typeof action.seconds !== "number" || !Number.isFinite(action.seconds) || action.seconds <= 0 || action.seconds > MAX_PLAY_SECONDS) invalid();
    if (!Array.isArray(action.lanes) || action.lanes.length < 1 || action.lanes.length > MAX_PLAY_LANES) invalid();
    for (const lane of action.lanes) {
      if (!lane || typeof lane !== "object" || Array.isArray(lane) || Object.getPrototypeOf(lane) !== Object.prototype) invalid();
      if (Object.keys(lane).length !== LANE_KEYS.length || LANE_KEYS.some((key) => !Object.hasOwn(lane, key))) invalid();
      if (!Number.isFinite(lane.x) || !Number.isFinite(lane.y) || lane.x < 0 || lane.x >= 1 || lane.y < 0 || lane.y >= 1) invalid();
      if (typeof lane.key !== "string" || !PLAY_KEYS.includes(lane.key)) invalid();
      if (!Array.isArray(lane.color) || lane.color.length !== 3 || lane.color.some((c) => !Number.isInteger(c) || c < 0 || c > 255)) invalid();
      if (!Number.isInteger(lane.tolerance) || lane.tolerance < 1 || lane.tolerance > 255) invalid();
    }
    return action;
  }
  if (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x < 0 || action.x >= 1 || action.y < 0 || action.y >= 1) invalid();
  if (action.type === "type_at" && (typeof action.text !== "string" || Buffer.byteLength(action.text, "utf8") > 4096)) invalid();
  return action;
}

async function validateScreenshotAttachment(attachment) {
  const invalid = () => { throw new ComputerUseContractError("invalid_attachment", "image attachment is not a private HALO screenshot"); };
  if (!attachment || typeof attachment !== "object" || Array.isArray(attachment) || Object.getPrototypeOf(attachment) !== Object.prototype ||
      Object.keys(attachment).length !== 3 || attachment.kind !== "image" || typeof attachment.id !== "string" || !UUID_RE.test(attachment.id) ||
      typeof attachment.path !== "string" || !path.isAbsolute(attachment.path) || path.basename(attachment.path) !== "observation.png") invalid();
  const resolved = path.resolve(attachment.path);
  const directory = path.dirname(resolved);
  const tmpPrefix = `${path.resolve(os.tmpdir())}${path.sep}halo-computer-use-`;
  if (!directory.startsWith(tmpPrefix)) invalid();
  let dirStat, fileStat, realPath, realDirectory;
  try {
    [dirStat, fileStat, realPath, realDirectory] = await Promise.all([fs.lstat(directory), fs.lstat(resolved), fs.realpath(resolved), fs.realpath(directory)]);
  } catch { invalid(); }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (dirStat.mode & 0o777) !== 0o700 ||
      !fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o777) !== 0o600 ||
      fileStat.size < 8 || fileStat.size > MAX_SCREENSHOT_BYTES || realPath !== path.join(realDirectory, path.basename(resolved))) invalid();
  let handle;
  let digest;
  try {
    handle = await fs.open(resolved, "r");
    const signature = Buffer.alloc(8);
    const { bytesRead } = await handle.read(signature, 0, signature.length, 0);
    if (bytesRead !== 8 || !signature.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid();
    const content = await fs.readFile(resolved);
    if (content.length !== fileStat.size || content.length > MAX_SCREENSHOT_BYTES) invalid();
    digest = crypto.createHash("sha256").update(content).digest("hex");
  } finally {
    await handle?.close();
  }
  return { kind: "image", id: attachment.id, path: resolved, digest };
}

async function createScreenshotAttachment(input) {
  const capture = validateScreenshotCapture(input);
  const digest = crypto.createHash("sha256").update(capture.png).digest("hex");
  const binding = Object.freeze({
    observationId: capture.observationId,
    taskId: capture.taskId,
    agentId: capture.agentId,
    documentEpoch: capture.documentEpoch,
    origin: capture.origin,
    capturedAt: capture.capturedAt,
    viewport: Object.freeze(capture.viewport),
    digest,
  });

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "halo-computer-use-"));
  let filePath;
  try {
    await fs.chmod(directory, 0o700);
    filePath = path.join(directory, "observation.png");
    await fs.writeFile(filePath, capture.png, { flag: "wx", mode: 0o600 });
    await fs.chmod(filePath, 0o600);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new ComputerUseContractError("attachment_not_private", "screenshot attachment is not a private regular file");
    }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ComputerUseContractError) throw error;
    throw new ComputerUseContractError("attachment_write_failed", "could not create a private screenshot attachment");
  }

  let disposed = false;
  const attachment = Object.freeze({
    id: crypto.randomUUID(),
    path: filePath,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await fs.rm(directory, { recursive: true, force: true });
    },
  });
  return { binding, attachment };
}

module.exports = {
  PLAY_KEYS,
  MAX_PLAY_SECONDS,
  ALLOWED_KEYS,
  ComputerUseContractError,
  MAX_SCREENSHOT_BYTES,
  MAX_VIEWPORT_DIMENSION,
  validateScreenshotCapture,
  validateCoordinateAction,
  validateScreenshotAttachment,
  createScreenshotAttachment,
};
