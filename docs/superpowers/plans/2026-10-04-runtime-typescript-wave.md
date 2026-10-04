# Runtime TypeScript wave implementation plan

**Goal:** Type six production runtime modules without changing their CommonJS or security contracts.

**Architecture:** Extend the existing two strict compiler cohorts. Maintain all existing JS consumer paths and deterministic publication checks.

**Spec:** ../specs/2026-10-04-runtime-typescript-wave-design.md

- [x] Port the router and three pure browser-boundary modules to strict TypeScript.
- [x] Port background runtime UI and launch-agent binding with structural host interfaces.
- [x] Extend exact source/output sets, build fixtures, export conformance, and compile-only consumers.
- [x] Check source types; publish with the local runtime stopped; check emitted freshness.
- [x] Run focused router/layout/transport/background/build regressions and the browser package suite.
- [x] Update migration documentation with the actual converted module count and remaining scope.

Verification: typecheck, build:runtime, and check:runtime passed; focused regressions 106/106; browser package suite 1707/1707. Production TypeScript-generated modules increased from 9 to 15. This is the first migration wave, not a full-runtime conversion.

Review focus: malformed external inputs, Error own-property order, lazy shared-contract imports, parent profile restrictions, recursive freezing, and local login-launch deferral.
