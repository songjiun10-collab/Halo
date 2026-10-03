# HALO

HALO consists of two projects: the safety and containment research core, and the
browser application built around controlled agent execution.

| Project | README | Scope |
| --- | --- | --- |
| HALO Core | [Core README](halo/README.md) | Containment research, experiments, authority policy and approval/execution gateway |
| HALO Browser | [Browser README](apps/computer-browser/README.md) | Electron browser, agents, long-running tasks, approval UI and local runtime |

Research results, reproduction commands, sandbox probes and gateway operations are
in the Core README. Browser setup, UI, providers and app tests are in the Browser README.

See the [architecture guide](docs/ARCHITECTURE.ko.md) for their responsibilities and
execution boundaries. The [container guide](deploy/container/README.ko.md) covers
the Core gateway's Docker execution and deployment.
