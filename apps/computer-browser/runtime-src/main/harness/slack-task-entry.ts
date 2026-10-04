"use strict";

// Slack slash command -> Halo task. This is only the verification and
// admission core: it has no listener, no network client and no token. A
// transport (a local HTTPS endpoint, a tunnel or Socket Mode) hands it the raw
// request and sends back its reply; nothing here reaches out to Slack.
//
// Fail-closed by design: the request must carry a valid, fresh Slack
// signature, come from an allowlisted workspace AND user (and channel when a
// channel list is set), pass a per-user rate limit and replay check, and
// carry a bounded non-empty request. Every refusal tells Slack only that the
// command was not accepted, never which check failed.

import crypto = require("node:crypto");

interface SlackTarget { agentId?: string, teamId?: string }
interface SlackEntryConfig {
  signingSecret: string;
  allowedTeamIds: readonly string[];
  allowedUserIds: readonly string[];
  allowedChannelIds?: readonly string[];
  target: SlackTarget;
  startTask: (input: { agentId?: string, teamId?: string, request: string }) => Promise<unknown>;
  toleranceSec?: number;
  maxRequestChars?: number;
  maxPerUserPerMinute?: number;
}
interface SlackReply { status: number, body: { response_type: "ephemeral", text: string } | null }
interface SlackRequest { rawBody: string, headers: Readonly<Record<string, string | undefined>>, nowMs?: number }

const MAX_BODY_BYTES = 8 * 1024;
const REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_TRACKED = 2000;
const ID = /^[A-Z0-9]{2,32}$/;

const ephemeral = (text: string): SlackReply => ({ status: 200, body: { response_type: "ephemeral", text } });
const NOT_ACCEPTED = "This command was not accepted.";

function hasIds(list: readonly string[] | undefined): list is readonly string[] {
  return Array.isArray(list) && list.length > 0 && list.every((id) => typeof id === "string" && ID.test(id));
}

function createSlackTaskEntry(config: SlackEntryConfig) {
  if (typeof config.signingSecret !== "string" || config.signingSecret.length < 16) throw new TypeError("signingSecret is required");
  if (!hasIds(config.allowedTeamIds) || !hasIds(config.allowedUserIds)) throw new TypeError("allowedTeamIds and allowedUserIds must be non-empty Slack ids");
  if (config.allowedChannelIds !== undefined && !hasIds(config.allowedChannelIds)) throw new TypeError("allowedChannelIds must be non-empty Slack ids when set");
  const hasAgent = config.target?.agentId !== undefined;
  const hasTeam = config.target?.teamId !== undefined;
  if (hasAgent === hasTeam) throw new TypeError("target needs exactly one of agentId or teamId");
  if (typeof config.startTask !== "function") throw new TypeError("startTask is required");
  const toleranceMs = (config.toleranceSec ?? 300) * 1000;
  const maxChars = config.maxRequestChars ?? 2000;
  const perMinute = config.maxPerUserPerMinute ?? 5;
  const seen = new Map<string, number>();
  const recent = new Map<string, number[]>();

  function validSignature(rawBody: string, timestamp: string, signature: string): boolean {
    const expected = Buffer.from("v0=" + crypto.createHmac("sha256", config.signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex"));
    const given = Buffer.from(signature);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async function handle({ rawBody, headers, nowMs = Date.now() }: SlackRequest): Promise<SlackReply> {
    const timestamp = headers["x-slack-request-timestamp"];
    const signature = headers["x-slack-signature"];
    if (typeof rawBody !== "string" || Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return { status: 401, body: null };
    if (typeof timestamp !== "string" || !/^\d{1,12}$/.test(timestamp) || typeof signature !== "string") return { status: 401, body: null };
    if (Math.abs(nowMs - Number(timestamp) * 1000) > toleranceMs) return { status: 401, body: null };
    if (!validSignature(rawBody, timestamp, signature)) return { status: 401, body: null };

    // Replay: the same signed request is accepted once.
    for (const [key, at] of seen) if (nowMs - at > REPLAY_TTL_MS) seen.delete(key);
    if (seen.has(signature)) return ephemeral(NOT_ACCEPTED);
    if (seen.size >= MAX_TRACKED) return ephemeral(NOT_ACCEPTED);
    seen.set(signature, nowMs);

    const form = new URLSearchParams(rawBody);
    const teamId = form.get("team_id") ?? "";
    const userId = form.get("user_id") ?? "";
    const channelId = form.get("channel_id") ?? "";
    const request = (form.get("text") ?? "").trim();
    if (!config.allowedTeamIds.includes(teamId) || !config.allowedUserIds.includes(userId)) return ephemeral(NOT_ACCEPTED);
    if (config.allowedChannelIds && !config.allowedChannelIds.includes(channelId)) return ephemeral(NOT_ACCEPTED);
    if (request.length === 0) return ephemeral("Usage: /halo <what you want done>");
    if (request.length > maxChars) return ephemeral(`That request is longer than ${maxChars} characters.`);

    const stamps = (recent.get(userId) ?? []).filter((at) => nowMs - at < 60_000);
    if (stamps.length >= perMinute) return ephemeral("Too many requests. Try again in a minute.");
    stamps.push(nowMs);
    recent.set(userId, stamps);

    try {
      await config.startTask({ ...config.target, request });
    } catch {
      return ephemeral("The task could not be started.");
    }
    return ephemeral("Task started in Halo.");
  }

  return { handle };
}

export = { createSlackTaskEntry };
