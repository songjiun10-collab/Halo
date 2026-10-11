# Halowright bundle 1 wiring: the `hw_step` action (2026-10-10)

## Scope

The Halowright layer (design `2026-10-07-halowright-design.md`, bundle 1 =
effect verification + locators/auto-wait + report enforcement) existed in the
host (`main/harness/halowright.js`, `halowright-locator.js`, `effect-verifier.js`,
committed as "Halowright bundle 1"), but the planner-facing action the design
names — `hw_step` — was wired nowhere: the model could only address elements by
`elementId`, so expressive role/label/text locators were unreachable. This
change connects the layer end to end.

## What changed

- `runtime-src/main/harness/halowright.ts`: exports `validateStep()` (the shape
  gate the adapter and controller use) and `gateActionFor()` (op → canonical
  action). `runHwStep` now reuses `validateStep`, and the `authorize` callback
  receives the resolved element's `role`, `name` and `inputType`.
- `runtime-src/main/harness/halowright-locator.ts`: the resolve probe returns
  the resolved element's `role`, `name` and `inputType` so the host can judge the
  element it is about to act on, not the locator string.
- `main/harness/browser-adapter.js`: `hw_step` joins `SUPPORTED_ACTIONS`; the
  adapter's own lock/mode gate judges it as `gateActionFor(op)`; a new `_hwStep`
  runs the step with an `authorize` callback that re-checks the live origin,
  Intent Lock, password fills and irreversible controls before any input.
- `main/harness/task-controller.js`: `gateActionOf`/`describeLocator`/
  `isAutoHwStep`; malformed steps are answered with a note and skipped; the lock/
  mode/lease gate and the effect-deny rule use the canonical action; the
  approval prompt names the locator (e.g. `Planner proposes hw_step: click button
  "Send message"`); benign clicks/fills on fully stated locators run on the
  approver's verdict like their elementId equivalents.
- `main/harness/action-gate.js`: `hw_step` target origin is the current page,
  like the coordinate actions.
- `main/harness/providers/claude-code-bridge.js`: `buildPrompt` (shared by all
  planner bridges) advertises the `hw_step` shapes and when to use them.
- `contracts/BROWSER-INTERACTIONS.md`: a `hw_step` section; the Limits line no
  longer denies shadow-root locators.

Gate mapping (one mapping, shared by adapter and controller):

| op | judged as | notes |
| --- | --- | --- |
| `click` | `click` | classifier can deny/ask; irreversible names refused pre-dispatch |
| `fill` | `type` | password fields refused at resolve time |
| `press` | `press_key` | key allowlist enforced by `validateStep` |
| `scroll` | `scroll` | browse-level, no effect check gate |
| `check`/`uncheck`/`select` | `click` | `select` value bounded to 200 chars |
| `hover` | `scroll` | pointer move only, never auto-queued |

## Red/green evidence

New tests were written against the wiring before they passed (`hw_step` was
`unknown_action` at the adapter gate — the first adapter run failed all six):

| File | Covers |
| --- | --- |
| `test/halowright.test.js` | `validateStep` bounds (op/text/key/value/dy/locator), `gateActionFor` for all eight ops |
| `test/hw-step-adapter.test.js` | adapter path: click effect `ok`, fill holds-text `ok`, password fill `not_authorized` with no input, irreversible resolved control `not_authorized`, malformed/ambiguous fail closed, lock deny as `click` |
| `test/task-controller-interactions.test.js` | controller path: benign locator click approver-only and dispatched; effect-named locator queued with the locator in the prompt, dispatched on approve; irreversible locator refused with no queue and no dispatch; malformed step no dispatch |
| `test/action-gate.test.js` | `hw_step` target origin is the current page |
| `test/claude-code-bridge.test.js` | the shared prompt advertises `"type": "hw_step"` |

Focused runs: `halowright` 26/26, `hw-step-adapter` 6/6,
`browser-interactions` + `task-controller-recovery` + `action-gate` +
`task-controller-interactions` 86/86, `task-controller` 91/91,
`claude-code-bridge` + `halowright-locator` + `action-gate` 62/62,
`npm run typecheck` and `npm run check:runtime` exit 0.

## Limits and verification status

- `runHwStep` through the real adapter is unit-tested with scripted pages;
  locator resolution itself has a real-Chromium test
  (`halowright-locator.test.js`), but no end-to-end task has yet driven a real
  site through `hw_step`. The adapter's `sendInputEvent` event types used by the
  step (`mouseWheel`, `char`, key events) were checked against
  `cdp-web-contents.js`, not measured live.
- The classifier judges a locator by what it states: a text/label-only locator
  without a role never auto-runs (it goes to the approver), by design — the
  resolved role is only known at resolve time.
- iframes and contenteditable remain out of scope (adapter Limits).
- No commit performed in the Halo repo; the Chromium tree is untouched by this
  change.
