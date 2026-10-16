# Halo Chromium (agent browser) fork

Status: started 2026-10-06. Branch `halo` created in `~/chromium/src` (base `32ecd686f2`, Chrome 157.0.8089.0).
Decision: the product owner chose to build a custom Chromium. This file records the measured starting point and the order of work.

## Step 0 result: the agent browser is `headless_shell`, not Chrome

The full Chrome binary in headless mode loads the browser UI (omnibox popup WebUI), default component extensions and their
service workers. `headless_shell` (target in the same tree, built in under a minute from `out/Trial`) has none of that.

16 GB M5, 10 isolated agents, same page, RSS of the whole process tree:

| Browser | baseline | 10 agents |
|---|---|---|
| Electron 44 (offscreen views) | 319 MB | 1,383 MB |
| Chromium Trial, `--headless=new` | 527-653 MB | 6,109-6,490 MB |
| Chromium Trial, `headless_shell` | 366 MB | 2,334 MB |

30 logical agents through the surface pool (cap 5 live, waves of 5):

| Browser | peak | steady (5 live) | 7 live | restore + observe |
|---|---|---|---|---|
| Electron 44 | 1.5 GB | 0.9 GB | - | 88 ms |
| Chromium `--headless=new` | 8.7 GB | 4.0 GB | 4.8 GB | about 2.3 s |
| Chromium `headless_shell` | 2.3 GB | 1.4 GB | 1.8 GB | about 1.5 s |

`headless_shell` also gives the renderer memory back at once on discard (the full browser took 20-40 s).
Caveats: the Trial build is a component build (shared libraries counted per process, so absolute numbers are high);
a release non-component build is the fair comparison and is not built yet.

## Build and use

```
apps/computer-browser/tools/build-halo-chromium.sh        # builds out/Trial/headless_shell
HALO_CHROMIUM=$HOME/chromium/src/out/Trial/headless_shell  # Halo then launches it for the Chromium engine
```
`cdp-browser-host` detects `headless_shell` and omits `--headless=new`. The CDP tests pass against both binaries.

## Patch workflow

Work on the `halo` branch in `~/chromium/src`; export with `git format-patch` into
`apps/computer-browser/chromium-patches/` so the Halo repo records every change as a patch series on a known base.
Rebase onto a new Chromium revision by re-applying the series; keep each patch small and independent.

## Next steps (order)

1. Release, non-component build (`is_component_build=false`) of `headless_shell` to get the fair memory number. Several hours.
2. Measure idle growth over 30 minutes and per-process breakdown (renderer heap, GPU, utility) before any tuning.
3. First patch candidates, each only if measured to matter:
   - drop the GPU process for agent pages that need no compositing (about 155 MB of the 2.3 GB);
   - a process-per-agent-group policy inside `content` (replace app-level context sharing);
   - a native "freeze but keep page state" path for parked surfaces, so a restore need not reload the URL.
4. Remove the restore reload only once (3) exists; until then restore stays one GET.
