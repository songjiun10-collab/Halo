# Halo runtime TypeScript migration: routing and browser boundaries

The user authorized a staged conversion of the browser's production runtime. The frontend already uses TypeScript. This wave adds six strict TypeScript sources to the existing deterministic CommonJS publication mechanism: task-profile-router, port-contracts, layout-constants, clamp-bounds, background-runtime-ui, and background-launch-agent.

Sources live under runtime-src. Existing consumers retain their CommonJS require paths. Generated JS remains checked in and is published only by build:runtime. The compiler remains TypeScript 6.0.2 with strict enabled and allowJs disabled. Every cohort's explicit source/output list, fixtures, and conformance checks expand together.

Public external inputs retain runtime validation, error codes, defaults, evaluation order, and frozen output semantics. Type-only declarations must not introduce enumerable error properties or __esModule exports. Parent capability restrictions and login-launch deferral from the recent review fixes remain identical.

Existing uncommitted controller, room, browser, provider, frontend, and integration changes remain outside this wave. The migration does not alter permission, approval, task journals, or replay policy. Runtime tests exercise generated JavaScript; compile-only tests exercise the source interfaces. Full app regression and source freshness are the completion criteria for this wave.

Later waves can migrate clean provider/configuration modules, then stateful stores and controllers once their concurrent changes settle. This document does not claim that all runtime modules are TypeScript.
