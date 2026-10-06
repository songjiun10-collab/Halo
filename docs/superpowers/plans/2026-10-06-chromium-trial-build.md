# Chromium trial build on this Mac

Status: plan only. Nothing here has been run. Start it after the Electron beta is validated
(the agreed order: Electron beta first, then Chromium).

## Purpose

Measure, on the hardware we already have, how long a Chromium build takes and whether the
disk and memory are enough. The result decides whether a rented Mac build host is needed.
It is not a commitment to fork Chromium; the decision gate in
`docs/superpowers/specs/2026-10-05-renderer-lifecycle-design.md` still applies.

## Machine (checked 2026-10-06)

- Apple M5, 10 cores, 16 GB RAM
- Xcode 27.0 (27A266a) installed, developer path set to `/Applications/Xcode.app`
- About 204 GB free on the data volume

16 GB is the low end for a Chromium link step, so the first build may be slow or fail at link
time. Close other heavy apps (agents, Docker, editors) while it runs.

## Steps (commands are from memory of the Chromium docs; check them against the current
official macOS build instructions before running)

1. Get `depot_tools` (`git clone` from `chromium.googlesource.com/chromium/tools/depot_tools.git`)
   and put it on `PATH`.
2. Fetch a shallow checkout to save disk:
   `fetch --nohooks --no-history chromium`, then `gclient sync`.
   Expected size: roughly 30-40 GB (estimate).
3. Generate a lean release build:
   `gn gen out/Trial --args='is_debug=false is_component_build=true symbol_level=0 blink_symbol_level=0 target_cpu="arm64"'`
4. Build: `autoninja -C out/Trial chrome`, and record the wall-clock time with `time`.
5. Record: peak memory (Activity Monitor), disk used by `src` and `out/Trial`, and whether
   the link step failed.

## Download approval

Steps 1-2 download tens of gigabytes from `chromium.googlesource.com`. Ask for explicit
approval (file, source, size) before running them.

## Decision after the trial

| Result | Decision |
| --- | --- |
| Full build under about 8 hours, no link failure, disk under about 150 GB | Keep building locally |
| Link fails or swaps heavily | Rent a cloud Mac with at least 32 GB RAM and 300 GB disk |
| Disk fills | Free more space or move to the rented host |

## Not covered

- Which Halo features need a Chromium change (see the decision gate in the lifecycle spec).
- Signing, notarization and packaging (packaging is out of scope for now).

## Trial result (2026-10-06)

- Build finished successfully: `autoninja -C out/Trial chrome` (Chrome 157.0.8089.0, V8 15.7.43,
  arm64, release, component build, symbol_level=0).
- Machine: Apple M5, 10 cores, 16 GB RAM.
- Disk after build: `~/chromium` 39 GB (`src` 38 GB, of which `out/Trial` 6.5 GB). Free 161 GB.
- Wall-clock: the final uninterrupted run reported `real 134m`; the whole build was interrupted
  and restarted several times (see below), so there is no single end-to-end number. Roughly
  11 hours from the first `autoninja` start to success, including the tuning detour.
- What went wrong and what fixed it:
  - First build failed in under a minute: Xcode's Metal toolchain was missing
    (`xcodebuild -downloadComponent MetalToolchain`, 839 MB).
  - With the default job count (about 14 at once) the heavy `blink/renderer/core` layout
    files made memory collapse (free memory 1%, swap 9 GB) and speed dropped to 10-50
    steps/min. Cutting to 5 jobs there gave 65-106 steps/min; 10 jobs on light directories
    reached 190-440 steps/min. Best setting depends on the directory: 5 jobs in
    `blink/renderer/core` and `content/browser`, 10 elsewhere.
  - A stuck ChatGPT helper used a core; closing other apps helped a little.
  - Resuming after `Ctrl-C` (SIGINT to siso) keeps finished work, so changing `-j` is cheap.
- First run: the GUI launch could not be verified because the screen was locked. A
  `--headless=new` run answered on the remote debugging port and rendered a test page
  (title read back over CDP).
- Link step did not fail on 16 GB.
- Decision (table above): full build under about 8 hours of compute and no link failure, disk
  well under 150 GB -> local builds are feasible, but weekly rebuilds will take hours of the
  whole machine. Not yet decided: whether to fork (see the lifecycle spec's decision gate).
