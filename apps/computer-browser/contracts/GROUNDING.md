# Grounding (hallucination device) v1

The runtime checks a `need_user` answer -- the path that carries a research
answer to the person -- against everything the task actually observed. A
specific claim in the answer (a model code, quantity, price, long number) that
appeared in no observation is unsupported by construction; the device either
asks the planner to revise it (bounded, host-owned correction turn) or surfaces
the unsupported list with the pause. It never modifies the answer itself.

Detector: `main/harness/grounding.js` (pure logic; the accuracy harness's
`integration/accuracy/grounding.js` re-exports it so both consumers share one
implementation). Corpus: every observation's text, title, URL, element
names/hrefs and HTTP status, **plus the task's own request text** — a value the
user supplied (the zip code to set) is grounded by the request, not a
hallucination; that false positive was found by the 2026-10-09 gpt-oss run and
is pinned by tests in both the harness and the controller. The corpus is
bounded to the last 24 observations / 512 KiB and kept in memory only — never
journaled, dropped with the controller.

## Behavior (task controller)

1. Every observation turn appends to the bounded corpus.
2. `need_user` proposals are checked before the pause. When unsupported
   specifics exist and a correction turn is available
   (`groundingCorrections`, default 1, `0` = measure only):
   - the proposal is not accepted yet; `state.groundingFeedback` (visible to
     the planner as `progress.groundingFeedback`) names the unsupported values
     and lists the pages this task observed (bounded, up to 8 URLs) so the
     planner can revisit one and copy the value exactly, instead of guessing,
   - a `grounding` journal note is appended with `outcome:
     "correction_requested"`,
   - the controller loops for one more planner turn. The feedback text never
     enters the corpus, so the planner cannot launder it as a source.
3. If the corrected answer is still unsupported (or the budget is spent), the
   pause proceeds with `snapshot.grounding = { unsupported: [...] }` and a note
   `outcome: "unsupported_kept"`, so the person sees exactly which values lack
   support.
4. Honest answers, answers without specifics, and any detector failure take the
   exact path they took before the device existed -- a detector bug never pauses
   or blocks a task.

## Prevention (why the planner fabricates less in the first place)

The built-in playbooks (`main/harness/skill-library.js`) carry the same rule
downstream of detection: the research playbook says every specific value must be
copied from a page actually read in the task (never inferred from memory, or the
absence said plainly), and the extraction playbook forbids filling gaps with
plausible values. Detection and correction catch what prevention misses; the
playbooks reduce how often the device has to fire at all.

This prevention text is **not measured yet**, and three real-planner A/B runs
(2026-10-09: Nemotron 3 Super ×2, gpt-oss-20b ×1) still could not measure it.
Across ~46 task-runs with a non-zero-fabrication model never appearing, genuine
fabrications are **0**: the trap (`unstated-spec-honesty`) was passed honestly
with and without the prevention text, and the single "fabrication" gpt-oss
flagged turned out to be a **corpus false positive** — the answer restated the
zip code from the task's own prompt, which the observation-only corpus did not
contain. That gap is fixed in both consumers (the task prompt now grounds; see
above) and pinned by tests. The passRate direction flipped between runs, so run
variance dominates. Mistral — the requested substitute — has no access on the
account used (all seven variants answer 404 "not found for account"); once
enabled, the runner re-runs it with one command. The runtime device does not
depend on this text.

## Limits (quote the number only with these)

- Catches unsupported specifics, not unsupported prose ("it is much faster"
  passes), and not fabrications built by pairing two values that each appeared
  somewhere.
- Unusual paraphrases can false-positive; that is why the unsupported list is
  always surfaced. A correction turn may strip a correct but unverifiable
  extra.
- The corpus is what the controller showed the planner in that task; it is not
  a general fact-checker. Cross-observation pairing errors are out of scope.
- The accuracy harness keeps the controller device at `groundingCorrections:
  0` and runs its own correction arm; the two layers must not correct each
  other's runs.

## Verification

From `apps/computer-browser/`:

```sh
node --test test/task-controller-grounding.test.js   # correction, budget, honest path, corpus
node --test test/accuracy-grounding.test.js          # detector vectors (shared with the harness)
node --test test/skill-library.test.js               # prevention text + its A/B switch
```

Real-planner A/B for the prevention text (key from `NVIDIA_API_KEY` or HALO Settings;
never printed):

```sh
node integration/accuracy/nvidia-grounding-ab.js --check   # resolve key/model only
node integration/accuracy/nvidia-grounding-ab.js           # both arms over the scored suite
```
