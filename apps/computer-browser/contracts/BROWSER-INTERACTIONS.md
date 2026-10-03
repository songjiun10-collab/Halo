# Browser interactions v1

The long-running browser adapter supports `observe`, `navigate`, `follow_link`,
`scroll`, `click`, `type` and `submit_form`. Actions retain the existing proposal,
permission, approval, journal, goal-version and document-epoch contracts.

```json
{"type":"click","elementId":"3"}
{"type":"type","elementId":"4","text":"Replacement text"}
{"type":"submit_form","elementId":"5"}
```

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

## Limits

No iframe, shadow-root, contenteditable or coordinate-action support is claimed.
Downloads remain unavailable pending a host-owned file broker. The task adapter
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
