# Generic MCP Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax. User explicitly requested implementation with existing Claude collaboration.

**Goal:** Support service-independent MCP discovery and approved execution while retaining HALO host authority.
**Architecture:** Provider backends expose list/describe/call only to a host broker. The broker owns bounded context, exact approvals, durable pre-dispatch and uncertain results. Task/renderer integration comes only after this boundary is tested.
**Tech Stack:** CommonJS Node, node:test, existing Codex JSONL transport; later official MCP/Claude SDK.
**Spec:** ../specs/2026-09-30-generic-mcp-broker-design.md

## Global Constraints

- No credential copying, global configuration mutation, frontend edits or pushes.
- Search 10 results/4KiB, schema 16KiB, args 16KiB, result 4KiB; 10s default deadline.
- Unknown/write require host human approval; annotation does not authorize.
- Exact schema/args/context/connection generation binding; durable claim before dispatch, no replay.
- Reaping barrier, cancelled remote calls may be uncertain, fail closed on teardown failure.

## Review Focus

- Caller mutating objects across an approval wait must not change execution.
- Same tool name from different providers must not collide.
- Append failure before execution must prevent the call; after dispatch must be uncertain.
- Schema/context drift and approval expiry must invalidate execution.
- Hung provider and slow/failed close must not reopen worker admission.

## Task 1 — Common host broker (Codex ownership)

Create `apps/computer-browser/main/harness/generic-mcp-broker.js` and `test/generic-mcp-broker.test.js`.
Interface: constructor providers, trusted getContext, validateArguments, requestApproval, journal.append; listConnections, searchTools, describeTool, proposeCall, dispatchApproved, close.

- [ ] Write failing tests for scope identity, bounded search, mutated arguments, replay, drift, expiry, pre/post append failure, timeout.
- [ ] Run `node --test test/generic-mcp-broker.test.js`; verify missing module/feature failure.
- [ ] Implement broker; validation callback is mandatory and fail-closed until host schema validator is wired.
- [ ] Run focused tests and record result; request cross-review from Claude.

## Task 2 — Generic Codex provider (Claude ownership)

Create `main/harness/providers/codex-mcp-provider.js` and `test/codex-mcp-provider.test.js`.
Interface: listConnections({signal}), listTools(connectionId,{signal}), describeTool(connectionId,toolName,{signal}), call(connectionId,toolName,args,{signal}), close(). Connection IDs `codex:<server>`.

- [ ] Write failing tests for paginated hosted services, callable status, deadlines, reaping, revoked connector.
- [ ] Implement only codex_apps by default; local servers require trusted explicit selection.
- [ ] Run focused tests; root reviews diff and public read-only smoke.

## Task 3 — TaskHost/controller integration and schema validation

- [ ] Read existing action/journal contracts; add separately validated MCP descriptors and scoped host settings.
- [ ] Test approve/deny/goal amendment/takeover/crash against actual TaskStore before implementing routing.
- [ ] Add local JSON Schema validation (no remote refs); make broker callbacks host-owned.
- [ ] Prove no raw provider call/approval minting is available to renderer/model.
- [ ] Full browser `node --test`, existing GitHub v1 smoke and explicit generic public read smoke.

## Task 4 — Direct MCP and Claude execution providers

- [ ] Approved stdio/HTTPS transport with fingerprint, DNS/redirect checks and separate user auth.
- [ ] Claude all-tools PreToolUse gate, default-mode exact human callback, no builtin or injected settings.
- [ ] Actual SDK fault-injection gate probes before enabling; unsupported statuses for unproven paths.
- [ ] Multi-service token/latency/RSS comparison; no saving claim from byte bounds alone.

## Progress / decisions

- Implementation authorized by user after written-spec delivery. Existing shared feature checkout preserved to collaborate with Claude; unrelated dirty files excluded.
- Tasks 1/2 are backend foundations, not a claim of finished all-MCP browser support. Tasks 3/4 remain required before feature-complete status.
- New implementation commits are deferred until reviewed tests and ownership are reconciled; no broad staging.
