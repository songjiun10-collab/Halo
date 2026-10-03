"use strict";

const crypto = require("node:crypto") as typeof import("node:crypto");
const contracts = require("../../shared/harness-contracts") as {
  MAX_PENDING_MESSAGES_PER_CONVERSATION: number;
  UUID_RE: RegExp;
  isPlainObject(value: unknown): value is Record<string, unknown>;
  validateJournalEvent(event: unknown): unknown;
};

type MaybePromise<T> = T | PromiseLike<T>;
type MessageKind = "progress" | "question" | "answer" | "steer" | "handoff" | "evidence";
interface Handoff {
  objective: string;
  currentState: string;
  verifiedResults: { text: string; evidenceId: string }[];
  unresolved: string[];
  risks: string[];
  suggestedNextAction: string;
}
interface MessageInput {
  [key: string]: unknown;
  conversationId: string;
  parentTaskId: string;
  childTaskId: string;
  senderTaskId: string;
  recipientTaskId: string;
  parentGoalVersion: number;
  kind: MessageKind;
  idempotencyKey: string;
  text?: string;
  handoff?: Handoff;
  evidenceRefs?: string[];
  inReplyToMessageId?: string;
}
interface MessageEnvelope extends MessageInput { messageId: string }
interface ConsumedInput { consumedMessageIds: unknown[]; observedAtPlannerCall?: unknown }
interface ConsumedPayload { consumedMessageIds: string[]; observedAtPlannerCall?: number }
interface JournalMetadata {
  seq: number;
  eventId: string;
  taskId: string;
  goalVersion: number;
  at: string;
}
interface MessageSentEvent extends JournalMetadata { type: "message_sent"; payload: MessageEnvelope }
interface MessageConsumedEvent extends JournalMetadata { type: "message_turn_consumed"; payload: ConsumedPayload }
type OtherJournalEventType =
  | "goal_created" | "task_profile_selected" | "goal_amended" | "action_started"
  | "action_outcome" | "evidence_recorded" | "approval_cancelled" | "note"
  | "child_plan_accepted" | "child_plan_cancelled" | "child_result_verified"
  | "routine_step_advanced" | "routine_step_denied" | "routine_step_failed";
interface OtherJournalEvent extends JournalMetadata {
  type: OtherJournalEventType;
  payload: Record<string, unknown>;
}
type JournalEvent = MessageSentEvent | MessageConsumedEvent | OtherJournalEvent;
interface TaskStore {
  taskId: string;
  getEvents(options: { since: number }): MaybePromise<JournalEvent[]>;
  getGoal(): { goalVersion: number };
  append(input: { type: "message_sent"; payload: MessageEnvelope }): MaybePromise<MessageSentEvent>;
  append(input: { type: "message_turn_consumed"; payload: ConsumedInput }): MaybePromise<MessageConsumedEvent>;
}
interface ConversationTaskIds { parentTaskId: string; childTaskId: string }
type GetTaskStore = (taskId: string) => MaybePromise<TaskStore | null | undefined>;
type GetConversationTaskIds = (conversationId: string) => MaybePromise<ConversationTaskIds | null | undefined>;
interface MailboxOptions {
  getTaskStore?: GetTaskStore;
  getConversationTaskIds?: GetConversationTaskIds;
  now?: () => number;
}
interface PendingRoute { senderTaskId?: string; recipientTaskId?: string }
interface SendResult { messageId: string; duplicate: boolean }

const MAX_PENDING_PER_CONVERSATION = contracts.MAX_PENDING_MESSAGES_PER_CONVERSATION;
// All mailbox instances in this V1 host process share admission and
// acknowledgement locks, even when they have distinct callback closures.
const senderLocks = new Map<string, Promise<void>>();
const conversationLocks = new Map<string, Promise<void>>();
const recipientLocks = new Map<string, Promise<void>>();

class MessageMailboxError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MessageMailboxError";
    this.code = code;
  }
}

// Journal pages are bounded by TaskStore. Scan all pages rather than relying
// on its recent-events window: an idempotency key lives as long as the journal.
async function readJournal(store: TaskStore): Promise<JournalEvent[]> {
  const events: JournalEvent[] = [];
  let since = 0;
  for (;;) {
    const page = await store.getEvents({ since });
    if (page.length === 0) return events;
    events.push(...page);
    since = page[page.length - 1].seq;
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if ((value as Record<string, unknown>)[key] !== undefined) result[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function canonicalMessage(envelope: MessageInput) {
  const { messageId, ...withoutId } = envelope;
  return JSON.stringify(canonical(withoutId));
}

function mintMessageId(senderTaskId: string): string {
  const senderBytes = Buffer.from(senderTaskId.replaceAll("-", ""), "hex");
  return `m${senderBytes.toString("base64url")}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function senderFromMessageId(messageId: unknown): string | null {
  if (typeof messageId !== "string" || !/^m[A-Za-z0-9_-]{22}_[0-9a-f]{32}$/i.test(messageId)) return null;
  const bytes = Buffer.from(messageId.slice(1, 23), "base64url");
  if (bytes.length !== 16) return null;
  const hex = bytes.toString("hex");
  const taskId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return contracts.UUID_RE.test(taskId) ? taskId : null;
}

function withLock<T>(locks: Map<string, Promise<void>>, key: string, operation: () => MaybePromise<T>): Promise<T> {
  const preceding = locks.get(key) || Promise.resolve();
  const result = preceding.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  locks.set(key, tail);
  tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return result;
}

class MessageMailbox {
  declare _getTaskStore: GetTaskStore;
  declare _getConversationTaskIds: GetConversationTaskIds;
  declare _now: () => number;
  declare _knownSendersByRecipient: Map<string, Set<string>>;

  constructor({ getTaskStore, getConversationTaskIds, now }: MailboxOptions = {}) {
    if (typeof getTaskStore !== "function" || typeof getConversationTaskIds !== "function") {
      throw new MessageMailboxError("invalid_config", "task store and conversation callbacks are required");
    }
    this._getTaskStore = getTaskStore;
    this._getConversationTaskIds = getConversationTaskIds;
    this._now = typeof now === "function" ? now : () => Date.now();
    // Discovery hint only, never an authority: each ID is checked against
    // both durable journals before an acknowledgement can be appended.
    // The public callback resolves conversation -> pair, not recipient ->
    // every possible sender. listPending populates this hint at each planner
    // checkpoint, including after a restart.
    this._knownSendersByRecipient = new Map();
  }

  _rememberPair(senderTaskId: string, recipientTaskId: string): void {
    let senders = this._knownSendersByRecipient.get(recipientTaskId);
    if (!senders) {
      senders = new Set();
      this._knownSendersByRecipient.set(recipientTaskId, senders);
    }
    senders.add(senderTaskId);
  }

  async _store(taskId: string): Promise<TaskStore> {
    const store = await this._getTaskStore(taskId);
    if (!store || store.taskId !== taskId || typeof store.getEvents !== "function" || typeof store.append !== "function") {
      throw new MessageMailboxError("task_unavailable", `task store unavailable for ${taskId}`);
    }
    return store;
  }

  async _relationship(envelope: MessageInput): Promise<ConversationTaskIds> {
    const relation = await this._getConversationTaskIds(envelope.conversationId);
    if (!relation || relation.parentTaskId !== envelope.parentTaskId || relation.childTaskId !== envelope.childTaskId ||
        !((envelope.senderTaskId === relation.parentTaskId && envelope.recipientTaskId === relation.childTaskId) ||
          (envelope.senderTaskId === relation.childTaskId && envelope.recipientTaskId === relation.parentTaskId))) {
      throw new MessageMailboxError("unauthorized_route", "message does not match the host conversation relationship");
    }
    return relation;
  }

  async send(messageEnvelope: unknown): Promise<SendResult> {
    // The coordinator supplies host-derived relationship fields. Snapshot the
    // object before waiting for a lock so a caller cannot change what is sent.
    let envelope: MessageInput;
    try {
      envelope = structuredClone(messageEnvelope) as MessageInput;
    } catch (err) {
      throw new MessageMailboxError("invalid_message", `message cannot be copied: ${(err as { message?: unknown }).message}`);
    }
    if (!contracts.isPlainObject(envelope) || !contracts.UUID_RE.test(envelope.senderTaskId || "") ||
        typeof envelope.idempotencyKey !== "string" || envelope.idempotencyKey.length === 0) {
      throw new MessageMailboxError("invalid_message", "senderTaskId and idempotencyKey are required");
    }
    if (Object.prototype.hasOwnProperty.call(envelope, "messageId")) {
      throw new MessageMailboxError("invalid_message", "messageId is assigned by the host mailbox");
    }
    return withLock(senderLocks, envelope.senderTaskId, async () => {
      const senderStore = await this._store(envelope.senderTaskId);
      const senderEvents = await readJournal(senderStore);
      const previous = senderEvents.find((event): event is MessageSentEvent => event.type === "message_sent" &&
        event.payload.senderTaskId === envelope.senderTaskId && event.payload.idempotencyKey === envelope.idempotencyKey);
      if (previous && canonicalMessage(previous.payload) !== canonicalMessage(envelope)) {
        throw new MessageMailboxError("idempotency_conflict", "idempotency key was used with different message content");
      }
      await this._relationship(envelope);
      if (previous) {
        this._rememberPair(envelope.senderTaskId, envelope.recipientTaskId);
        return { messageId: previous.payload.messageId, duplicate: true };
      }

      const payload = { ...envelope, messageId: mintMessageId(envelope.senderTaskId) };
      // Reject malformed content before touching the recipient journal.
      contracts.validateJournalEvent({
        seq: 0,
        eventId: crypto.randomUUID(),
        taskId: envelope.senderTaskId,
        goalVersion: senderStore.getGoal().goalVersion,
        type: "message_sent",
        payload,
        at: new Date(this._now()).toISOString(),
      });

      return withLock(conversationLocks, envelope.conversationId, async () => {
        // Both directions compete for one quota. Hold this lock until the
        // chosen sender's append has returned from its durable fsync.
        const recipientStore = await this._store(envelope.recipientTaskId);
        const [senderJournal, recipientJournal] = await Promise.all([
          readJournal(senderStore), readJournal(recipientStore),
        ]);
        const forward = this._pendingFromEvents(senderJournal, recipientJournal,
          envelope.conversationId, envelope.senderTaskId, envelope.recipientTaskId);
        const reverse = this._pendingFromEvents(recipientJournal, senderJournal,
          envelope.conversationId, envelope.recipientTaskId, envelope.senderTaskId);
        if (forward.length + reverse.length >= MAX_PENDING_PER_CONVERSATION) {
          throw new MessageMailboxError("queue_full", "conversation has 50 pending messages");
        }
        const event = await senderStore.append({ type: "message_sent", payload });
        this._rememberPair(envelope.senderTaskId, envelope.recipientTaskId);
        return { messageId: event.payload.messageId, duplicate: false };
      });
    });
  }

  _pendingFromEvents(senderEvents: JournalEvent[], recipientEvents: JournalEvent[], conversationId: string,
    senderTaskId: string, recipientTaskId: string): MessageEnvelope[] {
    const consumed = new Set(recipientEvents.filter((event) => event.type === "message_turn_consumed")
      .flatMap((event) => event.payload.consumedMessageIds));
    return senderEvents.filter((event): event is MessageSentEvent => event.type === "message_sent" &&
      event.payload.conversationId === conversationId &&
      event.payload.senderTaskId === senderTaskId &&
      event.payload.recipientTaskId === recipientTaskId &&
      !consumed.has(event.payload.messageId)).map((event) => event.payload);
  }

  async listPending({ senderTaskId, recipientTaskId }: PendingRoute = {}): Promise<MessageEnvelope[]> {
    if (!contracts.UUID_RE.test(senderTaskId || "") || !contracts.UUID_RE.test(recipientTaskId || "")) {
      throw new MessageMailboxError("invalid_message", "valid sender and recipient task IDs are required");
    }
    const [senderEvents, recipientEvents] = await Promise.all([
      this._store(senderTaskId!).then(readJournal),
      this._store(recipientTaskId!).then(readJournal),
    ]);
    const messages = senderEvents.filter((event): event is MessageSentEvent => event.type === "message_sent" &&
      event.payload.senderTaskId === senderTaskId && event.payload.recipientTaskId === recipientTaskId);
    for (const event of messages) await this._relationship(event.payload);
    if (messages.length > 0) this._rememberPair(senderTaskId!, recipientTaskId!);
    const consumed = new Set(recipientEvents.filter((event) => event.type === "message_turn_consumed")
      .flatMap((event) => event.payload.consumedMessageIds));
    return messages.filter((event) => !consumed.has(event.payload.messageId)).map((event) => event.payload);
  }

  async recordConsumed(recipientTaskId: string, consumedMessageIds: unknown,
    observedAtPlannerCall?: unknown): Promise<MessageConsumedEvent | null> {
    if (!Array.isArray(consumedMessageIds)) {
      throw new MessageMailboxError("invalid_message", "consumedMessageIds must be an array");
    }
    if (consumedMessageIds.length === 0) return null;
    const payload: ConsumedInput = { consumedMessageIds: [...consumedMessageIds] };
    if (observedAtPlannerCall !== undefined) payload.observedAtPlannerCall = observedAtPlannerCall;
    return withLock(recipientLocks, recipientTaskId, async () => {
      const recipientStore = await this._store(recipientTaskId);
      contracts.validateJournalEvent({
        seq: 0,
        eventId: crypto.randomUUID(),
        taskId: recipientTaskId,
        goalVersion: recipientStore.getGoal().goalVersion,
        type: "message_turn_consumed",
        payload,
        at: new Date(this._now()).toISOString(),
      });
      const recipientEvents = await readJournal(recipientStore);
      const alreadyConsumed = new Set(recipientEvents.filter((event) => event.type === "message_turn_consumed")
        .flatMap((event) => event.payload.consumedMessageIds));
      const pendingIds = new Set<unknown>();
      const candidateSenders = new Set(this._knownSendersByRecipient.get(recipientTaskId) || []);
      for (const id of payload.consumedMessageIds) {
        const senderTaskId = senderFromMessageId(id);
        if (senderTaskId) candidateSenders.add(senderTaskId);
      }
      for (const senderTaskId of candidateSenders) {
        let senderStore: TaskStore;
        try {
          senderStore = await this._store(senderTaskId);
        } catch (err) {
          if ((err as { code?: unknown }).code === "task_unavailable") continue;
          throw err;
        }
        const senderEvents = await readJournal(senderStore);
        for (const event of senderEvents) {
          if (event.type !== "message_sent" || event.payload.senderTaskId !== senderTaskId ||
              event.payload.recipientTaskId !== recipientTaskId) continue;
          await this._relationship(event.payload);
          if (!alreadyConsumed.has(event.payload.messageId)) pendingIds.add(event.payload.messageId);
        }
      }
      if (payload.consumedMessageIds.some((id) => !pendingIds.has(id))) {
        throw new MessageMailboxError("invalid_consumption", "every consumed ID must be pending for this recipient");
      }
      return recipientStore.append({ type: "message_turn_consumed", payload });
    });
  }
}

export = { MessageMailbox, MessageMailboxError, MAX_PENDING_PER_CONVERSATION };
