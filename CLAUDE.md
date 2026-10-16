## Design System
Read DESIGN.md before visual or UI work: it defines the fonts, colors, spacing, and
aesthetic direction. Ask the user before departing from it. When reviewing or QA-ing
UI, flag code that doesn't match DESIGN.md.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. Route only to skills in the session's available-skills list; answer directly for quick questions or small scoped edits.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec

## Working with the founder
Terse, Korean, approves with "ㄱ"/"ㄱㄱ". Wants direct, honest assessment, not flattery.
- Challenge your own claims before stating them. Say "public docs don't describe X", never "competitor lacks X".
- Benchmarks: always report over the full task set. Count CAPTCHA-blocked tasks as failures in their own column. Name the judge model and what it saw.
- Do not build or wire CAPTCHA solvers or bot-defense bypasses, including for benchmarks.
- Run the full test suite before merging (not before every push). Electron tests are abandoned and expected to fail as root.
- If the goal or purpose of a request is not stated, infer it from the last few turns; ask only when a wrong guess is costly.
