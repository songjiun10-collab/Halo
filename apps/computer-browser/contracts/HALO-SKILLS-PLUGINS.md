# HALO native playbooks and plugin boundary

Updated 2026-10-03. This is a focused design review of public agent-skill and
plugin patterns, not a claim that every GitHub repository was inspected. The
public index [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills)
lists more than 1,400 entries. The review sampled the official OpenAI,
Anthropic, and Claude plugin catalogs and the cross-vendor index.

## Star-ranked references

Counts below were read from GitHub on 2026-10-03. They are discovery signals,
not quality or safety scores. These are the high-star repositories whose
patterns were relevant to HALO's browser and harness work, not a universal
ranking of every skill repository.

| Repository | Stars | Pattern distilled into HALO |
| --- | ---: | --- |
| [obra/superpowers](https://github.com/obra/superpowers) | 294,528 | clarify intent, plan bounded work, verify before calling it done |
| [anthropics/skills](https://github.com/anthropics/skills) | 179,432 | package reusable instructions and load only relevant material |
| [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) | 100,587 | activate lifecycle guidance by task and keep a verification stage |
| [mvanhorn/last30days-skill](https://github.com/mvanhorn/last30days-skill) | 63,391 | gather multiple current sources and distinguish popularity from evidence |
| [Cloudflare/security-audit-skill](https://github.com/Cloudflare/security-audit-skill) | 23,809 | separate leads from confirmed findings and independently challenge evidence |
| [NVIDIA/SkillSpector](https://github.com/NVIDIA/SkillSpector) | 19,142 | treat imported skills and plugin definitions as supply-chain input |
| [Agent Skills for Context Engineering](https://github.com/muratcankoylan/Agent-Skills-for-Context-Engineering) | 18,061 | bound context and make progress/checkpoints explicit |

HALO encodes the browser-relevant distilled rules as original text in its
host-owned playbooks. Coding-agent-only steps such as editing a repository or
running shell-based test suites do not become browser abilities.

## What HALO adopts

Skills commonly package task-specific instructions and supporting material,
then load only what a task needs. Plugins commonly bundle skills, commands,
agents, and MCP connections. HALO uses those ideas in a deliberately smaller
form:

- `main/harness/skill-library.js` contains short, original, host-authored
  playbooks for security reviews, source-grounded research, consequential
  forms, bounded data extraction, and long tasks.
- `context-builder.js` selects at most two playbooks from the user's original
  request and places them in `haloPlaybooks`, capped at 3 KiB. Selection never
  examines page text, memory, MCP results, or model summaries.
- The planner may follow a playbook only within the existing task goal,
  capability profile, proposal schema, action review, evidence checks, and
  budgets. A playbook grants no capability and cannot approve an action.
- Connected services remain MCP providers managed by the existing broker.
  MCP remains host-configured and gated; a skill cannot install a provider or
  invoke a tool directly.

## What HALO deliberately does not import

No GitHub skill or plugin is downloaded or executed. In particular, HALO does
not load third-party scripts, hooks, commands, local configuration, agents,
MCP server definitions, or marketplace manifests into planner processes.
Those packages can contain executable code and change independently of their
catalog entry. The Claude plugin directory itself warns that included MCP
servers and software are not verified by Anthropic. HALO therefore keeps its
own reviewed playbooks separate from provider plugin systems; the Claude CLI
also runs with tools, slash commands, plugins, hooks, MCP servers, and custom
settings disabled.

This is an initial native playbook layer, not universal compatibility with
every Agent Skills format or plugin marketplace. Future imports should be
explicit, version-pinned, locally reviewed, license-checked, size-bounded, and
limited to declarative text unless a separately sandboxed executor is designed.

## Sources reviewed

- [OpenAI skills catalog](https://github.com/openai/skills): its README marks
  this repository deprecated and points to OpenAI's plugin repository for
  current examples; it describes skills as folders of instructions, scripts,
  and resources.
- [OpenAI plugins](https://github.com/openai/plugins): current plugin example
  repository.
- [Anthropic skills](https://github.com/anthropics/skills): skills are
  self-contained folders with `SKILL.md` and optional resources; the repository
  labels its examples educational and says to test them before critical use.
- [Anthropic official Claude plugins](https://github.com/anthropics/claude-plugins-official):
  plugin structure includes optional MCP config, commands, agents, and skills;
  its README explicitly warns users to trust/check included software.
- [VoltAgent awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills):
  cross-provider index used to identify common domains such as browser work,
  research, extraction, development, and security. The list is a discovery
  index, not an endorsement or executable dependency.
- [NVIDIA SkillSpector](https://github.com/NVIDIA/SkillSpector) and
  [Cloudflare security-audit-skill](https://github.com/Cloudflare/security-audit-skill):
  security-oriented examples used to shape supply-chain caution and
  evidence-validation guidance; neither scanner is embedded or represented as
  running inside HALO.

## Current coverage

The initial built-ins compress recurring workflow guidance, not vendor- or
service-specific knowledge. Existing HALO browser actions, Routine execution,
Work Goals, evidence tracking, permission policy, and MCP providers continue
to provide the actual mechanisms. New playbooks should be added only when they
improve a measurable browser task without changing those authority boundaries.
