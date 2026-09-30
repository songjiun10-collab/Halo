# Runtime TypeScript migration

The frontend already uses TypeScript. The Electron runtime remains CommonJS
JavaScript. This first step adds a diagnostic-only check of the shared harness
contract and its imported dependencies, without changing executable files.

## Reproduce the initial audit

Install the existing frontend dependencies first, then from the repository root:

```sh
./frontend/node_modules/.bin/tsc -p apps/computer-browser/tsconfig.audit.json
```

This temporary audit explicitly uses the frontend's TypeScript 6 and Node types.
It is not a standalone runtime build, and it is not yet a passing CI gate.
Existing diagnostics must be resolved before making this check mandatory.
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
