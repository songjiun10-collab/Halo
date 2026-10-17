"use strict";

// Tool-side allowlist for the overnight inbox assistant. Mail text is untrusted data:
// whatever a model proposes after reading it is authorized here, never by the mail.
// Only label, summarize and draft exist. Anything else, or any extra field, is refused.

const MAX_ACTIONS_PER_BATCH = 200;
const MAX_LABEL_LENGTH = 64;
const MAX_TEXT_LENGTH = 4000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const hasExactKeys = (value, keys) => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const refuse = (reason) => ({ ok: false, reason });

// The host, not the model, supplies the context:
//   messageIds   Set of message ids in tonight's batch
//   labels       Set of label names the user already configured
function authorizeAction(action, context) {
  if (!isPlainObject(action) || typeof action.type !== "string") return refuse("not_an_action");
  if (!context || !(context.messageIds instanceof Set) || !(context.labels instanceof Set)) return refuse("missing_context");
  switch (action.type) {
    case "label":
      if (!hasExactKeys(action, ["type", "messageId", "label"])) return refuse("unexpected_fields");
      if (typeof action.messageId !== "string" || !ID_RE.test(action.messageId)) return refuse("bad_message_id");
      if (!context.messageIds.has(action.messageId)) return refuse("message_not_in_batch");
      if (typeof action.label !== "string" || action.label.length === 0 || action.label.length > MAX_LABEL_LENGTH) return refuse("bad_label");
      if (!context.labels.has(action.label)) return refuse("label_not_configured");
      return { ok: true };
    case "summarize":
      if (!hasExactKeys(action, ["type", "messageId", "text"])) return refuse("unexpected_fields");
      if (typeof action.messageId !== "string" || !ID_RE.test(action.messageId)) return refuse("bad_message_id");
      if (!context.messageIds.has(action.messageId)) return refuse("message_not_in_batch");
      if (typeof action.text !== "string" || action.text.length === 0 || action.text.length > MAX_TEXT_LENGTH) return refuse("bad_text");
      return { ok: true };
    case "draft":
      // A draft is saved, never sent, and its recipients come from the host (the original sender
      // of that message), so the model cannot name one.
      if (!hasExactKeys(action, ["type", "messageId", "body"])) return refuse("unexpected_fields");
      if (typeof action.messageId !== "string" || !ID_RE.test(action.messageId)) return refuse("bad_message_id");
      if (!context.messageIds.has(action.messageId)) return refuse("message_not_in_batch");
      if (typeof action.body !== "string" || action.body.length === 0 || action.body.length > MAX_TEXT_LENGTH) return refuse("bad_body");
      return { ok: true };
    default:
      return refuse("action_not_allowed");
  }
}

// Authorizes a whole proposal. All-or-nothing: one refused action rejects the batch, so a
// partly hijacked proposal cannot run its harmless-looking half.
function authorizeBatch(actions, context) {
  if (!Array.isArray(actions)) return { ok: false, reason: "not_a_list", results: [] };
  if (actions.length > MAX_ACTIONS_PER_BATCH) return { ok: false, reason: "too_many_actions", results: [] };
  const results = actions.map((action) => authorizeAction(action, context));
  const firstRefusal = results.find((result) => !result.ok);
  return firstRefusal ? { ok: false, reason: firstRefusal.reason, results } : { ok: true, results };
}

module.exports = { authorizeAction, authorizeBatch, MAX_ACTIONS_PER_BATCH };
