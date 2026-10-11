# Browser interactions v1

The long-running browser adapter supports `observe`, `navigate`, `follow_link`,
`scroll`, `find`, `click`, `type`, `submit_form`, `evaluate` and `hw_step`. Actions retain the existing proposal,
permission, approval, journal, goal-version and document-epoch contracts.

```json
{"type":"click","elementId":"3"}
{"type":"type","elementId":"4","text":"Replacement text"}
{"type":"submit_form","elementId":"5"}
{"type":"find","text":"Refund policy","direction":"next"}
```

`find` is read-only and allowed in every permission mode. It scrolls the current
page to the next (`direction: "next"`, default) or previous occurrence of the
text, selects it, and answers `found` true/false; repeated calls continue from
the current selection. The query is at most 200 characters / 256 UTF-8 bytes and
control characters are stripped. On the Chromium engine the match is found with
`window.find`, so there is no all-matches highlight or match count; Electron
surfaces report `matches`/`active` from `found-in-page`.

`zoom` is read-only and allowed in every permission mode. Direction walks the
browser ladder (0.25x .. 4x); `level` accepts an absolute step in that range.
It applies Chromium's CSS `zoom` to the root element, which was measured
(2026-10-10) to scale layout, hit-testing, observation geometry and captures
together, so normalized coordinates remain exact. The zoom is not persisted
across navigations: a new document starts at 1x.

`select_all` is read-only: it performs the select-all editing command.
`copy` is an interact-class action (human-gated in `interact`, bypass in
`full`): it reads `window.getSelection()` (at most 1 MiB) and writes it to the
OS clipboard, returning the text truncated to 16,384 characters so a later
`type` action can paste it elsewhere. HALO never reads the user's clipboard;
an empty selection answers `ok` with `chars: 0`.

Use one interaction per proposal and obtain a fresh observation before the next
interaction. `elementId` must name an element in that observation; it is not a
CSS selector. `type` replaces a native input or textarea value and accepts at
most 4,096 UTF-8 bytes. Password and file inputs use neither this action nor a
planner-supplied script. Credential autofill remains a separate host path.

Observation captures DOM references and accessible-identity fingerprints in
Electron isolated world 1001. The registry never enters planner context. A
detached, hidden, disabled or changed target, changed form action, stale document,
or origin denied by the intent lock is refused. Main-world prototype replacement
does not replace the isolated world's native action methods.

Bindings are consumed before dispatch. Renderer rejection or a five-second
dispatch timeout returns `uncertain`, not a retryable success/failure. A timed-out
operation blocks another observation until its underlying promise actually
settles. Existing controller handling records execution uncertainty and requires
human recovery. `ok` means the native operation returned; it does not prove a
server accepted a form or that the task's completion criterion was satisfied.

The review target includes the observed element name, replacement text for input,
and form destination/method when present. Existing permission-mode semantics are
unchanged, including explicit `full` mode. These origin checks constrain known
link/form destinations and navigation; they do not inspect arbitrary site event
handlers' fetch requests or prove prompt-injection containment.

## `hw_step` (Halowright locators)

`hw_step` names an element instead of binding an elementId; the host resolves it
when the step runs, waits until it is actionable, acts, then verifies that the
page changed (design: `docs/superpowers/specs/2026-10-07-halowright-design.md`).

```json
{"type":"hw_step","step":{"op":"click","locator":{"role":"button","name":"Sign in"}}}
{"type":"hw_step","step":{"op":"fill","locator":{"label":"Email"},"text":"a@b.co"}}
{"type":"hw_step","step":{"op":"press","key":"Enter"}}
{"type":"hw_step","step":{"op":"scroll","dy":600}}
{"type":"hw_step","step":{"op":"get_text","locator":{"role":"heading","name":"Refund policy"}}}
```

- `locator` is exactly one of `{role, name}`, `{label}`, `{text}`, `{placeholder}`
  or `{testid}`, optionally with `nth` and one nested `within`. Open shadow roots are
  searched; a closed root is never matched. A match that is hidden, disabled,
  covered, moving or ambiguous is refused without input — `locator_ambiguous`
  returns up to five candidates.
- `op` is `click`, `fill`, `hover`, `press`, `check`, `uncheck`, `select`,
  `scroll` or `get_text`. `fill` text is at most 4,096 UTF-8 bytes; `press` accepts the
  navigation/editing keys (`Enter`, `Tab`, `Escape`, `Backspace`, arrows);
  `scroll` needs a non-zero `dy` of at most 5,000. `get_text` needs a locator,
  sends no input, and answers `{ status: "ok", text, truncated }` with at most
  4,096 UTF-8 bytes of the element's text (`truncated: true` when cut).
- Gating: the Intent Lock, permission mode, lease, approval prompt and effect
  classification judge a `hw_step` as the elementId action it performs
  (`click`→`click`, `fill`→`type`, `press`→`press_key`, `scroll`→`scroll`,
  `hover`/`check`/`uncheck`/`select`→`click`, `get_text`→`find`), and the approval prompt names the
  locator. A locator that itself names an irreversible control is refused
  outright, like the coordinate path.
- The host authorizes the **resolved element** immediately before any input: a
  fill that resolves to a password field, a resolved controllable the classifier
  refuses, or a lock/origin change during the wait all send nothing. `ok` is
  reported only when a change was observed (or the field holds the text);
  otherwise the step is `uncertain` and never retried automatically. Secrets
  remain with the person.

## `evaluate` (one read-only expression)

```json
{"type":"evaluate","expression":"document.title"}
```

`evaluate` runs one JavaScript expression in the page's isolated world and
answers `{ status: "ok", evaluateResult: { authority: "untrusted_page", value, truncated } }`
with at most 4,096 UTF-8 bytes of its JSON value. The expression is at most
2,000 characters; statements are a syntax error (`evaluate_threw`), and a
value that cannot survive a page-side JSON round-trip is `uncertain`
(`evaluate_not_serializable`) — neither is retried automatically. The answer
is page data for the next turn (`observation.evaluateResult`), never
verification evidence and never instructions.

Gating: `evaluate` always needs the person's approval (a lease can never
authorize it, and `observe`/`browse` modes cannot propose it). The model's
expression runs as page code, so review it like the write it performs.

## Limits

No iframe or contenteditable support is claimed; `hw_step` locators search open
shadow roots, the elementId registry does not. Coordinate actions remain their
own contract (`computer-use-contract.js`). Downloads remain unavailable pending a
host-owned file broker. The task adapter
cancels Chromium downloads initiated by its own page, including indirect ones.
Named forms and submit buttons can be addressed; native form validation is retained
through `requestSubmit`, rather than bypassed through `form.submit()`.

## Verification

From `apps/computer-browser/`:

```sh
node --test test/browser-interactions.test.js test/task-controller-interactions.test.js
./node_modules/.bin/electron integration/browser-interactions-electron.js
```

The Electron fixture uses only a disposable loopback site. It checks native
input events, a click under main-world prototype poisoning, DOM replacement,
password refusal, intent-lock denial, and exactly one real form POST.
