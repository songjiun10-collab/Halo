# Task Branches: keep working while an approval is pending

Date: 2026-10-05
Status: Design for review
Scope: HALO Browser task controller (`task-controller.js`, `child-agent-coordinator.js`)

## Problem

When a step needs a human, `TaskController` parks it in `_approvalQueue` and the loop
stops. Approvals are bound to the observation epoch with a 60 s expiry, so the task cannot
simply keep acting on the same page: any later action may depend on the pending one, and the
page may change under it. The user pays for this twice: the agent idles, and the user is
pulled in at the agent's schedule.

## Decision

A **Task Branch** is a short-lived, observe-only child of the parent task that runs the
*independent* remainder of the plan in a separate background tab while the parent's pending
action waits. It reuses the existing child-task machinery (children are already
observe-only; the parent alone requests human review). No new execution authority is added.

### Rules

1. **Trigger.** An approval enters the queue and the planner has at least one remaining
   step it marks `independent_of: <pending approval id>`. No marker, no branch: the task
   waits exactly as it does today.
2. **Isolation.** A branch gets its own tab and profile slot, never the parent's page. It
   can only read, navigate and scroll (policy mode `browse` at most), regardless of the
   user's global mode. Anything that would need `interact` or higher is recorded as a
   *deferred step* instead of executed.
3. **Parent stays authoritative.** The branch cannot approve, resolve or widen anything. The
   parent's pending approval, its epoch binding and its 60 s expiry are untouched.
4. **Bounded.** At most 1 branch per pending approval and 2 per task; each limited to a
   step budget (default 12) and a wall-clock budget (default 5 min). It ends when the
   approval resolves, the budget ends, or the user stops the task.
5. **Merge.** When the approval resolves, the branch's findings are handed to the parent as
   *untrusted observations* (the same path as `ChildAgentCoordinator` handoffs), never as
   instructions. Deferred steps become ordinary proposals that go through the normal gate.
   A rejected approval discards the branch's findings that depended on it.
6. **Visibility.** Activity shows one line per branch ("Reading X while waiting for your
   approval") and its outcome. The auto-handled counter includes branch reads.
7. **Journal.** `task_branch_started`, `task_branch_step`, `task_branch_deferred`,
   `task_branch_merged`, `task_branch_discarded`, each carrying the parent approval id.

### Non-goals

Parallel *writes*, branches that act on the parent's page, branches that survive an app
restart (they are dropped, parent resumes as today), and cross-task branching.

## Implementation slices

1. **Contract:** `independent_of` on planner step proposals, `task_branch_*` journal types,
   validators (`shared/harness-contracts`, runtime-src mirror, generated JS).
2. **Coordinator:** `ChildAgentCoordinator.startBranch(parent, approvalId, steps)` minting an
   observe-only child with step/time budgets and its own background tab.
3. **Controller:** on queue insert, offer independent steps to the coordinator; on resolve
   or reject, merge or discard; stop propagates to branches.
4. **UI:** Activity line and branch status in the snapshot (`TaskSnapshot.branches`).
5. **Tests:** branch never gets `interact`; approval epoch and expiry unaffected;
   merge-as-untrusted; reject discards dependent findings; budgets; stop; restart drops.

## Open questions

- Whether the planner can reliably label `independent_of`. If not, slice 1 falls back to a
  host heuristic: only read-only navigation to origins other than the pending target's.
- Tab budget under the memory policy ("Budgeted" may refuse a branch; that is fine).
