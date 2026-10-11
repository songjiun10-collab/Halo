# HALO

HALO is a desktop browser for working with AI agents. It combines real Chromium
pages, task and team workspaces, and a host-controlled execution runtime. HALO Core
provides the project's safety research and approval/execution gateway.

![HALO agent workspace with agents and a team room](docs/images/halo-agent-home.png)

## Demo: a human check is routed around, never solved

![HALO agent hits a human-check page and answers from another source](docs/images/halo-captcha-reroute.gif)

The agent starts on a page that shows a "Verify you are human" check. HALO does not
try to pass it: the challenged site is marked blocked, the task is steered to another
source, and the answer comes from there. If the agent instead tries to click on the
challenge, or a second site is blocked, the task pauses for you (`captcha`). Page loads
on the same site are also spaced at least 1.5 seconds apart.

The demo runs against local mock pages (`127.0.0.1`), not real sites. The main area is the live
mirror of the agent's hidden browser view; the sidebar is cropped out of the recording.

## HALO Browser

The Chromium desktop app brings browser controls, agents and long-running tasks
into one workspace. Its React UI runs in full Chromium while a local Node.js host
manages planner connections, browser surfaces and saved task state. Electron
remains a development dependency for legacy comparison tests and benchmarks;
the production application runtime does not load it.

- **Browser workspace:** real web pages with navigation and tab controls, alongside
  task and agent panels.
- **Agents and teams:** agent configuration, team rooms and parent/child task
  coordination, with host-managed execution boundaries.
- **Long-running tasks:** saved goals, durable event journals, progress checks and
  recovery state. Pause, stop and takeover let the user intervene.
- **Execution review:** approval queues, policy checks and document epochs keep
  proposals tied to the state they were made against.
- **Local workflow:** routines, local memory and credential storage, with provider
  setup and optional routed MCP tool proposals.
- **Recovery on hard tasks (opt-in):** planner escalation steps up to a stronger
  model tier when one fails, and routing picks a tier by expected task length.
- **Effect-based approval:** actions are auto, ask or deny by effect; irreversible
  clicks (payments, account deletion) are refused outright in text-mode computer use.
- **Context Awareness (opt-in):** an encrypted local journal of pages you read that
  later tasks can recall. It skips sign-in, payment, mail and bank pages.

Current version: `0.1.0-beta`. The opt-in features are off by default.

### Run locally

From the repository root, with Node.js compatible with the pinned app packages,
a full Chromium build and Python 3.11+ for the local approver:

```sh
npm --prefix frontend ci
npm --prefix apps/computer-browser ci
npm --prefix apps/computer-browser start
```

Configure a planner using the [provider guide](apps/computer-browser/main/harness/providers/README.ko.md).
The [Browser README](apps/computer-browser/README.md) covers the Chromium-first
runtime, its loopback bridge, source ownership and compatibility tests.

Browser permission modes are `observe`, `browse`, `interact` and `full`.
Routed MCP execution proposals require human approval regardless of that mode.
Task recovery records uncertain execution for review; an interrupted action is
not assumed safe to repeat.

## HALO Core

Core studies model-agnostic containment through synthetic experiments, Python/Rust
implementations and sandbox probes. Its gateway separates approver and executor
authority, requiring exact, short-lived capabilities and durable execution records.

The [Core README](halo/README.md) contains results, reproduction commands and research
limits. The [container guide](deploy/container/README.ko.md) covers its Docker gateway;
the browser uses a separate local approver. Compose does not containerize browser tasks.

See the [architecture guide](docs/ARCHITECTURE.ko.md) for shared boundaries. HALO is a
research prototype. Claims depend on stated threat models; no general containment
guarantee is claimed.
