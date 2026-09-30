# Runtime TypeScript migration

The frontend already uses TypeScript. The Electron runtime remains CommonJS
JavaScript. This first step adds a diagnostic-only check of the shared harness
contract and its imported dependencies, without changing executable files.

## Reproduce the initial audit

Install the browser package dependencies first, then from the repository root:

```sh
npm --prefix apps/computer-browser run typecheck
```

This audit uses the browser package's pinned TypeScript 6.0.2 and Node 24 types.
It is not a standalone runtime build. The shared-contract audit now passes;
the command is available locally but is not yet wired into CI.
Do not suppress them with `ts-nocheck`, blanket `any`, or a relaxed strict mode.

## Boundaries

1. Add precise shared contract types while retaining runtime input validation.
2. Type the generic MCP provider/broker interface.
3. Migrate controller and scheduler only after concurrent runtime changes settle.
4. Introduce a dedicated runtime compiler toolchain and emitted CommonJS build
   before renaming executable modules to `.ts`.

Approval, journal formats, cancellation, expiry, and execution-uncertain behavior
must remain unchanged. Runtime tests and type checks are complementary; neither
replaces the other. This audit does not claim that the runtime has been converted
to TypeScript.

## Current collaboration

- Claude owns strict JSDoc typing in `shared/harness-contracts.js`,
  `shared/task-profile-contracts.js`, `shared/harness-profile.js`, and
  `shared/capability-registry.js`, with runtime regression tests.
- Codex owns the compiler dependencies, audit configuration, npm command,
  documentation and independent verification. No frontend changes are needed.
- Executable filenames, journal schemas and approval semantics stay unchanged.
- Initial strict audit baseline: 154 diagnostics; current shared audit: zero.
  Later runtime modules remain outside this first check's scope. Do not disable
  strict checking when expanding that scope.
