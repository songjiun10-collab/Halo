# Agent-Owned Persistent Browser Profiles

## Goal

Use the general product idea of continuity between tasks for the same named Agent, but design the mechanism from HALO's own journal, approval, and session-isolation model. Do not copy or port OpenDots source code, APIs, data structures, service layout, or UI.

## Context

OpenDots is inspiration only for the user-visible concept of per-specialist continuity. HALO already has named Agents and Teams, a host-owned approval queue, action journaling, and dual visible/hidden browser views. Its current Electron sessions are in-memory and task-scoped; a child view shares its parent's session. This design intentionally derives from those HALO boundaries and makes no claim of architectural or implementation equivalence to OpenDots.

No OpenDots code is to be copied. Its Docker/OpenBot supervisor, CopilotKit/AG-UI, Slack, voice, and document workspace are not part of this phase; they have different deployment and trust boundaries from HALO's local Electron app.

## V1 scope

- An Agent may opt into a HALO-managed continuity profile. Existing and new Agents default to disabled. This profile is a HALO-owned partition identity derived from the host Agent record, not a copied external service or schema.
- Only a task started through the host-validated single-Agent path may bind to that Agent's profile. Renderer-supplied selectors cannot name or override the profile owner.
- The host durably records the selected Agent ID in the task journal before browser construction. Recovery resolves the owner from that record and current AgentStore policy; missing, archived, or disabled owners fail closed to stopping/refusing the bound task, never silently switching profiles.
- The visible task view and hidden agent view use the same stable Electron persistent partition for an opted-in Agent. Ordinary tasks remain on their current ephemeral per-task partition. Partition derivation and lifecycle are implemented and tested solely against HALO's own code and invariants.
- Team parent and child tasks remain on the current ephemeral task/parent partition. No child inherits an Agent's persistent profile in V1.
- Existing browser action approval and audit journaling remain authoritative. The profile preference grants persistence, not permission to bypass action approval or capability checks.
- Turning persistence off prevents new tasks from attaching and stops active tasks using that profile before reporting revocation complete. It does not delete cookies or profile data. V1 has no profile purge UI; archival/disable must preserve data rather than imply deletion.
- Imported-session injection is not combined with persistent Agent profiles in V1. Agent-started runs use their profile directly; generic imported-session tasks keep the current flow.

## Data and trust boundary

- Extend HALO AgentStore's validated record/input with `persistentBrowser` (boolean, default false when absent in older stored records). Updating this preference remains a host IPC operation and increments the Agent generation like other security-relevant profile changes.
- The AgentService passes the owner only through its host-internal task-creation callback. Public `createTask` selectors continue rejecting an Agent/profile-owner field.
- Persist the binding with a HALO-owned, exact journal contract before `_attachPrepared`. TaskStore replay exposes the validated binding on the loaded store; it is not inferred from UI state, free-form goal text, or the later display-only AgentStore link. The contract must distinguish this security-relevant selection from untyped display notes.
- Construct the partition only from a host-validated UUID: `persist:halo-agent-${agentId}`. Never accept partition names or arbitrary paths from renderer/model/page input.
- Disabling or archiving an Agent serializes against new direct Agent starts, makes the profile unavailable before notifying the UI, and stops active tasks bound to its profile before returning. If stopping/disposal fails, keep the profile unavailable for new work and report failure; do not claim revocation completed. A not-yet-attached queued task whose owner opts out is durably marked stopped without constructing its persistent partition. Profile bytes remain intact.

## UI and behavior

- Add a HALO-native Agent setting, off by default, explaining that cookies/site storage will be shared by future tasks for that same Agent and retained on this device across app restarts. Generic Agent edits must omit this security-relevant setting so stale UI state cannot implicitly re-enable it.
- Enabling requires a confirmation step before saving. The setting is independent from task action permission mode.
- Show whether the Agent uses an isolated temporary session or its persistent Agent profile. Do not display cookie values or site contents in audit entries.
- Existing task creation and generic browser flows are unchanged. Teams are not silently assigned a member's profile.

## Testing and acceptance

- AgentStore tests: old records default off; input accepts only boolean; unknown/malformed values reject; duplicate Agent copies do not inherit an enabled persistent profile unless explicitly chosen (V1 decision: duplicate defaults off).
- AgentService/TaskHost tests: only validated direct-Agent starts bind an owner; public selectors cannot spoof it; teams, child tasks, and generic tasks stay ephemeral; the binding is journaled before attach and survives restart; disabled/archived owners refuse recovery/start.
- AgentViewportHost tests: both visible and hidden views use the same persistent partition for an opted-in Agent; default tasks keep distinct in-memory task partitions; child tasks retain existing parent-task behavior.
- Revocation tests: disabling an Agent prevents further profile use, stops and disposes active bound tasks, and retains the on-disk profile; injected stop/dispose failure does not report successful revocation.
- UI tests: default-off setting, explicit enable confirmation, and persistence state display.
- Run `npm test` in `apps/computer-browser` and `npm run build` plus relevant frontend tests. No live websites or real user credentials are required.

## Out of scope

- Persistent filesystems or shell execution, Docker/OpenBot provisioning, profile export/import/purge, team-wide shared profiles, child profile delegation, remote/cloud computers, and Slack/voice integration.
- Claiming that Chromium profile persistence itself is a sandbox or that it protects secrets from the local OS account.

## Open implementation constraint

The feature increases cross-task state by design. It must remain an explicit Agent opt-in, separate from normal task permissions, and must never be selected based solely on a task's text or renderer-provided profile identifier.
