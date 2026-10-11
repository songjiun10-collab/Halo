# Halo Chromium (agent browser) fork

Status: started 2026-10-06. Branch `halo` created in `~/chromium/src` (base `32ecd686f2`, Chrome 157.0.8089.0). Patch series: `0001` (`ee502d2ca5`), `0002` (`b0eb13a8e9`) and `0003` (`36c74cc694`), all exported under `apps/computer-browser/chromium-patches/`.
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

## Patch 1 (2026-10-09): `--halo-vibrancy-*` — first commit on the branch

The branch was cut at `32ecd686f2` and carried **zero** commits until now; the
patch workflow below had never actually run. A session written on 2026-10-07/09
(the UI window had been passing `--halo-vibrancy-width` / `--halo-vibrancy-tint`
/ `--enable-features=GlassFrame` with a "needs the patched Chromium" comment
the whole time) left the Chromium side uncommitted in the working tree. It is
now committed and exported:

- Commit: `ee502d2ca5` on `halo` (first commit on the branch, base `32ecd686f2`).
- Export: `apps/computer-browser/chromium-patches/0001-Halo-native-vibrancy-behind-the-leading-column-of-an.patch`
  (verified: `git apply --check --reverse` matches the tree, i.e. the export is
  exactly what the branch carries).
- Files: `browser_native_widget_mac.mm` (blur + tint views, full-size content
  view), `browser_view.cc` (no web-app frame toolbar, transparent frame
  background), `contents_web_view.cc` (transparent contents), `glass_frame_service.cc`
  (TYPE_APP opt-in), `browser_view_app_layout_impl.cc` (no title strip inset).
- Every change is guarded by `HasSwitch("halo-vibrancy-width")`; a build without
  the switch behaves upstream.

Verified end to end on `out/TrialLean` (patch compiled 00:56, framework linked
00:57; both switch strings present in the 450 MB framework binary) by
`integration/probe-vibrancy-flags.js`: at `--window-size=1600,1000`,
`window.innerHeight` is **1000** with the switch against **968** without it —
the full-size content view the glass needs. Visual appearance (blur/tint
quality) is not measured by that probe and needs a human look at the window.

First patch not from the "if measured to matter" candidate list above; it was
already a product requirement, so it went first. Consequences for the list:
the GPU-process candidate measured small (`--in-process-gpu` saves ~52 MB of
1450 MB, 3.6%, and one process at 10 agents), and the renderer is 81% of the
RSS sum but only ~28 MB of *physical footprint* per page — RSS was overstating
renderer memory ~4x through shared library pages. Any further patch should be
chosen against footprint, not RSS.

## Patch 2 (2026-10-10): `--halo-vibrancy-*` fix pass

Commit `b0eb13a8e9` on `halo`, exported as
`chromium-patches/0002-Halo-make-halo-vibrancy-self-contained-and-leak-free.patch`
(verified with `git apply --check --reverse`). It resolves every item from the
patch-1 review:

- the gutter is created from `OnWidgetInitDone()` and only needs the switch
  (no `GlassFrameService`, no `kGlassFrame`, no eligibility conditions), so a
  build without the feature still gets the blur;
- the blur/tint views are members removed in `OnWidgetDestroyed()`, so
  eligibility cycles cannot stack copies;
- all consumers go through `halo::IsVibrancyEnabledForBrowser()`: the
  process-global switch no longer strips chrome from popups/devtools, and a
  malformed `--halo-vibrancy-width` disables the treatment instead of
  producing a chromeless transparent window;
- RTL puts the gutter on the leading (right) edge;
- the glass-frame opt-in promo is suppressed in the halo window;
- `RemoveGlassBackground()` keeps the halo window non-opaque across
  eligibility changes;
- `ContentsWebView::UpdateBackgroundColor()` guards the tab lookup on
  `web_contents()`. The unguarded lookup was added in this fix pass and
  crashed every launch (`SIGSEGV` in `SupportsUserData::GetUserData`, caught
  with lldb) until the guard was added during verification.

Verification (2026-10-10, `out/TrialLean/Chromium.app`, screen unlocked):

- launch: plain / halo / GlassFrame-only / halo+GlassFrame all stay up.
  Before the null guard, all of them (including plain) crashed at launch;
- `integration/probe-vibrancy-flags.js`: `window.innerHeight` is 1000 with
  the switch against 968 without it at `--window-size=1600,1000`;
- `integration/tmp-vibrancy-glass-measure.js` (run with and without
  `--enable-features=GlassFrame`): the leading strip tracks a red/blue/green
  backdrop behind the window (red `[156,140,139]` vs blue `[139,139,155]`)
  with identical values in both flag sets, while the stock `out/Trial`
  binary paints the strip opaque (`[34,34,33]` on red); the page area stays
  opaque `#101010` (`[16,16,16]`);
- the glass appearance was confirmed by eye on screen.

Probe caveats: the measure script's own verdict is "inconclusive" because its
"stock strip must be flat" premise fails on macOS 26 — the upstream glass
frame also blurs the whole window — and several captures in the split-gradient
arm were invalidated by window-order races. The per-channel numbers above are
read from the report manually. Not verified: fullscreen transitions,
multi-display, and a runtime check of the RTL branch.

An earlier attempt at this fix pass was abandoned before any edit on request;
it was redone after the patch-1 review, and the redone version itself needed
the null-guard fix found in the verification above.

## Patch 3 (2026-10-10): `--halo-identity` — stop self-advertising automation

Commit `36c74cc694` on `halo`, exported as
`chromium-patches/0003-Halo-present-the-stock-Chromium-identity-instead-of-.patch`
(`git apply --check --reverse` verified). Product-owner request: "캡차의 빈도
낮추는 패치". Motivation: the measured identity of both windows.

| Window | | before | after |
| --- | --- | --- | --- |
| agent (`headless_shell`) | UA | `HeadlessChrome/157.0.8089.0` | `Chrome/157.0.0.0` |
| | UA-CH brands | `[Not-A.Brand;99, HeadlessChrome;157, Chromium;157]` | `[Chromium;157, Not-A.Brand;99]` |
| | `navigator.webdriver` | `true` | `false` |
| desktop `--app` window | `navigator.webdriver` | `true` | `false` |

The desktop window carried `webdriver=true` although a person drives it: the
host launches it with `--remote-debugging-port=0`, and Blink's
AutomationControlled feature keys on that (as on `--headless` and
`--enable-automation`). The agent's UA and brand list came from
`headless/lib/browser/headless_browser_impl.cc` (`kHeadlessProductName`); the
after-values are identical to this tree's full browser (measured), except
`navigator.languages` (agent `en-US`, full browser `ko-KR`), which is left
alone.

- `headless_browser_impl.cc`: with the switch, `GetProductNameAndVersion()`
  returns `embedder_support::GetProductAndVersion()` and `GetUserAgentMetadata()`
  skips the HeadlessChrome brand regeneration.
- `content/child/runtime_features.cc`: turns `AutomationControlled` off after
  the switch- and port-driven enabling, so `navigator.webdriver` is false.
- `render_process_host_impl.cc`: forwards `--halo-identity` to renderers.

Halo passes `--halo-identity` in `LEAN_FLAGS` (`runtime-src/main/harness/cdp-browser-host.ts`);
it is not in the desktop strip list, so both the agent browser and the desktop
window get it. Without the switch nothing changes. The challenge policy is
untouched (detect, pause, hand off; never solve), and the declared identity
remains the Web Bot Auth signature; `contracts/WEB-BOT-AUTH.md` was updated to
describe the new presentation honestly. The `--enable-automation` flag stays
for its other automation semantics; it no longer produces a page-visible
webdriver signal. Not measured: any actual CAPTCHA-rate delta on live sites.
