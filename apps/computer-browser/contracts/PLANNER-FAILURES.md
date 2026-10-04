# Planner failure and shutdown contract

The persistent worker consumes `{requestId, context}` JSONL requests. Successful
responses remain `{requestId, proposal, usage?}`. A failed request now returns:

```json
{"requestId":"the-current-request-id","error":{"code":"cli_error"}}
```

Only `planner-failure.js` codes are allowed. Unknown exceptions become
`planner_failed`. Exception messages, model output, credentials and arbitrary
diagnostic fields are not sent in the response or copied into the worker error
log. An error cannot coexist with proposal/usage fields. Invalid error envelopes
are rejected; mismatched IDs are discarded like stale successful responses.

The transport rejects the matching request immediately, retires its worker and
requires confirmed exit before replacement. TaskController uses its existing
`planner_error` pause path. This does not add retries or change approval,
`execution_uncertain`, goal-version or document-epoch semantics. Older success-only
workers remain compatible; their silence still uses the existing deadline.

The shared CLI bridge registers its close listener before sending termination,
settles cancellation before signalling, and terminates children on stdin write
failure. Admission stays closed while that child is still alive. `close()` also
signals a live child whose request already failed, and escalates after its
existing five-second grace period.

## Reproduction

`node --test test/planner-stdio.test.js test/claude-code-bridge.test.js
test/claude-code-worker.test.js` from the browser directory includes the real
stdio fixture `fixtures/planner-failure-worker.cjs`. It never launches a model
CLI or accesses the network.

On 2026-10-03, five local fixture runs with a 60,000 ms response deadline returned
`planner_failed` in 70.16–82.61 ms, median 73.38 ms including Node startup. Confirmed
worker exit took 71.36–84.42 ms. These numbers measure failure notification and
cleanup, not model inference or browser task throughput.
