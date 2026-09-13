# Case-based safety regressions

HALO keeps a small defensive regression catalog derived from public AI-safety and
agent-security research. The catalog stores **behavioral abstractions**, not jailbreak
prompts or exploit strings.

The goal is to test invariants that remain meaningful when an attack is rephrased,
translated, obfuscated, or otherwise changes surface form.

## Research basis

- **AgentDojo** — Debenedetti et al. (2024), arXiv:2406.13352. Indirect prompt
  injection in tool-using agents; motivates treating third-party/tool content as
  untrusted provenance and evaluating downstream actions.
- **The Instruction Hierarchy** — Wallace et al. (2024), arXiv:2404.13208.
  Motivates privilege ordering between instruction sources rather than relying on
  attack-string matching.
- **SHADE-Arena** — Anthropic (2025), arXiv:2506.15740. Motivates trajectory-level
  checks for covert side objectives and sabotage.
- **SLEIGHT-Bench** (2026). Motivates explicit monitoring-gap and blind-spot tests.
- **Agentic Misalignment in Summer 2026** — Anthropic. Motivates independent artifact
  validation for covert changes that may leave a run looking superficially successful.
- **OpenAI prompt-injection guidance / Safety Bug Bounty** (2025–2026). Motivates
  treating unauthorized external actions and sensitive-data egress as agentic safety
  failures rather than merely undesirable text outputs.
- **Automated prompt-injection research in AgentDojo** (2026). Motivates testing
  transfer across unseen phrasings/tasks instead of memorizing a fixed set of attacks.

## Invariants encoded in `halo/safety_cases.py`

1. Untrusted content does not gain authority merely because it appears inside a tool
   result or another representation.
2. External writes require independent approval.
3. Secret-bearing data cannot cross to external scope without a separate trusted
   authorization path.
4. Permission-changing actions require independent approval.
5. Task scope expansion is surfaced explicitly.
6. Authorization and effect-time world-state versions are compared.
7. Produced artifacts can be checked against independently expected digests.
8. Missing telemetry is represented as uncertainty instead of silently treated as
   evidence of safety.
9. Evaluation-probing behavior is surfaced for review rather than inferred from a
   single phrase.

## What this does *not* claim

- These rules do not prove containment of a frontier model.
- The catalog is not a complete jailbreak taxonomy.
- A finding is not proof of malicious intent.
- String-based jailbreak signatures are intentionally excluded because they are easy
  to overfit and can create a misleading sense of coverage.

The intended workflow is:

`public failure class -> abstract invariant -> regression case -> held-out variants`

A new public incident should therefore add the smallest invariant needed to represent
its failure mode, plus benign counterexamples, rather than adding the incident's raw
prompt as a signature.
