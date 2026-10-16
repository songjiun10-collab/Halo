# Chromium harness connection lifecycle

## Approved scope

Settings changes affect new pages only. Pages and sessions are pinned to their
creation settings. A retired connection stays alive until its final page closes,
then is reclaimed. Failed transport attachment cleans up its owned browser.
Explicit release invalidates stale providers and drains pending attachments.
Approval policy and execution-uncertain retry behavior are unchanged.

## Implementation

- TypeScript source: `apps/computer-browser/runtime-src/main/harness/cdp-engine.ts`.
- Each generation owns an immutable settings snapshot, connection, context map,
  session map and page reference count.
- Page destruction releases a reference exactly once. Retired generations close
  at zero references; the current generation keeps contexts for session reuse.
- Closed session providers fail with `cdp_generation_released`, never rebound to
  a newer generation.
- Attach failure preserves the original error and attempts browser cleanup.
- Shutdown snapshots all generations and awaits their pending connections.

## Evidence

- Five regression tests failed before the implementation for the expected
  reasons, then passed afterward. Two additional shutdown/concurrency checks
  pass; seven lifecycle checks in total.
- Actual local Chromium integration confirms that old page content and cookies
  survive a settings change, new pages get a separate context, and reclaiming
  the old browser leaves the new page working.
- Focused desktop/engine run: 17 passed (before adding two supplemental checks).
- Typecheck and generated-runtime build pass.
- The initial full regression found one idle-restoration test tied to the old
  private numeric generation field. It now asserts a closed old CDP transport,
  successful saved-URL restoration and a different live transport; the actual
  Chromium test passes (1/1).
- Final fresh full-suite verification (`npm test -- --test-concurrency=2`):
  1,916 passed, 0 failed, 0 skipped; 346.788 seconds. Generated-runtime
  consistency check also passed as part of that command.

## Limits

This patch does not add browser-restart storage persistence, retry uncertain
actions, or change human approval. Keeping old pages alive temporarily retains
old browser processes; they are reclaimed only when those pages close.
No product UI launch, user Keychain access, commit or push was performed.
