---
# gstack: design-md-format=spec
name: Halo
description: A quiet near-black browser where agents work in a visible workspace beside your tabs, and the only color is a small signal that something needs you.
colors:
  backdrop: "#0c0e0d"
  chrome: "#0c0e0d"
  toolbar: "#151816"
  sidebar: "#151816"
  surface: "#151816"
  hover: "#1d201e"
  well: "#292d2a"
  border: "#292d2a"
  border-strong: "#666d67"
  text: "#e7e8e4"
  text-muted: "#858c86"
  primary: "#e7e8e4"
  on-primary: "#0c0e0d"
  accent: "#a8c7fa"
  accent-on-site: "#3b6fc4"
  on-accent: "#ffffff"
  warning: "#b99752"
  error: "#c86a64"
  success: "#72a982"
  site-bg: "#f8fafc"
  site-text: "#0f172a"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontWeight: 600
    fontSize: 1.125rem
    letterSpacing: -0.01em
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: 0.8125rem
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif"
    fontSize: 0.6875rem
    letterSpacing: 0.02em
  mono:
    fontFamily: "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"
    fontFeature: tnum
rounded:
  sm: 4px
  md: 8px
  lg: 12px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.md}"
  input:
    borderColor: "{colors.border-strong}"
    rounded: "{rounded.sm}"
  panel:
    backgroundColor: "{colors.sidebar}"
    rounded: "{rounded.lg}"
  nav-link:
    textColor: "{colors.text}"
---

# Halo

## Overview

**Creative North Star:** A workbench with the lights low. Tabs are the bench you already know; agents are tools laid out beside them where you can see what each one is doing, and the room only gets louder when a tool needs your hand.

**Product context:** Halo is a Chromium-based desktop browser with built-in AI agents. The first users are people who already left a mainstream browser because its agent stalled, hit CAPTCHAs, or ate memory. Beta is a limited public release in January.

**Mode per surface:** Operate (tabs, toolbar, agent panel, approvals). Read (activity log, task results). The web page itself is the site's own surface and is never restyled.

**Memorable thing:** Agents live next to tabs, not behind a chat box. If someone remembers one thing, it is the sidebar with two honest halves: Tabs and Agents.

**Key characteristics:**
- Near-black with a faint green cast; flat layers separated by 1px lines, not shadows.
- Color is rare. Ice blue means Halo (brand, focus). Amber means it needs you. Red means blocked. Green means done.
- Tabs area keeps parity with Chrome and Arc muscle memory. The Agents area is where Halo is allowed to be new.
- Trust is visible: every agent action is in the log, and anything irreversible stops at an approval sheet.

## Colors

**Strategy:** Restrained. Neutrals plus one brand hue; status colors are small and desaturated.
**Light or dark:** Dark chrome, decided by use scene: long sessions, often in a dim room or alongside a code editor, with the page inside the viewport staying light or dark as the site chooses. A light chrome theme exists behind `data-theme="light"` and must pass the same contrast checks; dark is the default and the one we design against.

Neutrals derive from `backdrop` (#0c0e0d) in small steps (`toolbar`/`sidebar` → `hover` → `well`). The primary action is neutral (`primary` is the foreground tone), so blue is never mistaken for a button color and stays free to mean "Halo". `accent` is for brand marks, focus rings and the active-agent dot only. `accent-on-site` is the deepened ice used when a Halo element sits on a light web page. Status colors appear only as dots, glyphs, short text, or a 2px bar; `error` is never a filled surface. Text on `backdrop`, panels and hover meets 4.5:1 (muted) and 11:1 (primary); control edges (`border-strong`) meet 3:1.

## Typography

Halo is browser chrome: it should feel native on each OS, so the UI uses the platform system sans stack (SF Pro on macOS, Segoe UI Variable on Windows). That is a deliberate exception to "pick a real typeface": in Operate mode on a native shell, matching the OS is the quality bar, and it costs no load time. Hierarchy comes from size and weight steps, not from a display face. Monospace (SF Mono / JetBrains Mono fallback, tabular numbers) is used only for URLs, selectors, amounts and log detail, so anything "machine" reads as machine. Marketing surfaces, when they exist, may take a distinct display face; none is chosen yet and no font is pending verification for the app.

The older `design-system/halo/MASTER.md` named JetBrains Mono headings and IBM Plex Sans; the shipped `frontend/src/styles/tokens.css` does not use them. The code wins. MASTER.md should be treated as superseded by this file.

## Layout

Window: tab strip, toolbar, then a two-part sidebar and the page viewport. The sidebar has two stacked regions with an explicit divider: Tabs (vertical or compact tabs, Chrome/Arc parity) and Agents (running, waiting-for-you, finished). Density is high (comfortable at 13px body, 4px base grid). Agents rows show state first (a status dot), then goal, then elapsed time; long goals truncate with a tooltip, never wrap the row. The first viewport after launch shows a normal browser, not a landing page.

## Elevation & Depth

Depth is mostly flat: 1px `border` lines between layers. Three glass materials exist and only these may float over the page: chrome (top bar), floating (activity, chat, notice, toast, tab overview), and critical (approval sheet). Material identity comes from opacity (94–96% near-black), with a small blur (10–20px) only for edge texture. Shadows have an offset (`0 -12px 24px` raised, 1px window outline). No zero-offset colored glow, no halo behind content.

## Shapes

4px for controls and inputs, 8px for buttons and tabs, 12px for panels and sheets, full radius only for status dots and avatars. Nested radius = outer radius − gap. Not everything is rounded the same amount.

## Components

- **Tab:** selected tab joins the toolbar color; hover uses `hover`; close button appears on hover/focus; focus-visible ring is `accent`.
- **Agent row:** status dot (accent running, warning waiting, success done, error blocked), goal text, elapsed. Waiting-for-you rows sort to the top.
- **Approval sheet:** critical glass, names the exact action and target (site, amount, currency). Primary = approve (neutral fill), secondary = decline. For payments it shows the cap and the page total side by side. Irreversible actions are never approved by default.
- **Activity log:** mono for detail, one line per action, newest at the bottom, errors marked with a 2px `error` bar plus text.
- **Inputs:** `border-strong` edge, `accent` focus ring, label above, error text below in `error`.
- **States for every component:** hover, focus-visible, active, disabled, loading, empty, error, and long content are all designed. Empty Agents area says what an agent can do and offers one example task; it is not a blank panel.

## Do's and Don'ts

- Do keep Tabs behaviour identical to what Chrome/Arc users expect; put novelty only in Agents.
- Do show agent state with a dot plus a text label; color never carries meaning alone.
- Do keep the page viewport untouched; Halo UI floats around or over it only through the three glass materials.
- Do keep payment and approval copy literal: site, amount, currency, and what happens next.
- Do keep motion under 300ms; exits shorter than enters.
- Don't use blue as a button fill; blue means Halo.
- Don't add gradient backgrounds, glow, or card-inside-card layouts.
- Don't use emoji or mascots as status or decoration.
- Don't fill a surface with `error` or `warning`; use a dot, glyph, short text, or 2px bar.
- Don't make the agent a floating chat bubble that covers the page by default.

## Motion

- **Approach:** minimal-functional
- **Easing:** enter `cubic-bezier(0.23, 1, 0.32, 1)` (strong ease-out), exit ease-in, move ease-in-out
- **Duration:** press 160ms, enter 220ms, exit 150ms; nothing over 300ms. Respect `prefers-reduced-motion` by replacing movement with opacity.
- **The one authored moment:** when an agent finishes a task or asks for approval, its row's status dot settles into its new color (a single 220ms transition) and the row moves to its sorted position. Nothing else animates for its own sake.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-13 | Initial DESIGN.md created from shipped `tokens.css` plus product context | Code is the source of truth; `design-system/halo/MASTER.md` (JetBrains Mono / IBM Plex Sans, graphite tones) was an earlier direction and is superseded |
| 2026-10-13 | Dark chrome by default | Long sessions beside editors; page keeps site's own theme |
| 2026-10-13 | System font stack for UI | Native shell, Operate mode; mono only for machine detail |
| 2026-10-13 | Neutral primary button, blue reserved for Halo | Keeps brand hue meaningful (running/focus) |
| 2026-10-13 | Tabs parity, Agents novelty | Adoption risk is in the tab muscle memory; differentiation is in the agent workspace |
| 2026-10-13 | No preview or outside voices run | User unavailable to review; the system documents already-shipped tokens, so nothing new needed visual approval. Revisit if marketing surfaces are designed |
