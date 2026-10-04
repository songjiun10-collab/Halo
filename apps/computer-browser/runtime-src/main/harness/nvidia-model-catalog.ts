"use strict";

// Dynamic NVIDIA model discovery. The endpoint is fixed by the host (no page,
// model output or renderer string can change it), redirects are rejected, the
// key only goes to that endpoint, and the response is bounded and every id is
// shape-checked before it can become a planner model.

const ENDPOINT = "https://integrate.api.nvidia.com/v1/models";
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MODELS = 500;
const DEFAULT_TIMEOUT_MS = 10000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
// Hosted catalog entries that are plainly not chat planners.
const NON_CHAT_RE = /embed|rerank|retriev|guard|safety|reward|clip|diffusion|parakeet|canary|tts|asr|whisper|ocr|parse|segment/i;

type FetchFn = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; body?: AsyncIterable<Uint8Array> | null }>;
interface CatalogOptions { apiKey?: unknown; fetchFn?: FetchFn; timeoutMs?: number; signal?: AbortSignal }

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(`NVIDIA catalog: ${code}`), { code });
}

// Pure: turns a /v1/models response body into a deduplicated, bounded id list.
function parseModelIds(data: unknown): string[] {
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw failure("invalid_response");
  const ids = new Set<string>();
  for (const entry of list) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !ID_RE.test(id) || NON_CHAT_RE.test(id)) continue;
    ids.add(id);
    if (ids.size >= MAX_MODELS) break;
  }
  return [...ids];
}

async function fetchNvidiaModelIds({ apiKey, fetchFn = globalThis.fetch as unknown as FetchFn, timeoutMs = DEFAULT_TIMEOUT_MS, signal }: CatalogOptions = {}): Promise<string[]> {
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) throw failure("authentication_failed");
  const controller = new AbortController();
  const cancel = (): void => controller.abort(failure("cancelled"));
  if (signal?.aborted) throw failure("cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(failure("timeout")), timeoutMs);
  try {
    const response = await fetchFn(ENDPOINT, { method: "GET", redirect: "error", signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
    if (!response.ok) {
      throw failure(response.status === 401 || response.status === 403 ? "authentication_failed" : response.status === 429 ? "rate_limited" : "http_error");
    }
    if (!response.body) throw failure("invalid_response");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) throw failure("invalid_response");
      chunks.push(Buffer.from(chunk));
    }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw failure("invalid_response"); }
    return parseModelIds(data);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    const code = (error as { code?: unknown } | null)?.code;
    const safe = ["authentication_failed", "rate_limited", "http_error", "invalid_response"];
    throw failure(typeof code === "string" && safe.includes(code) ? code : "network_error");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export = { NVIDIA_MODELS_ENDPOINT: ENDPOINT, parseModelIds, fetchNvidiaModelIds };
