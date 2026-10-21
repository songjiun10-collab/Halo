---
# gstack: design-md-format=spec
name: Halo
description: A light, glassy browser where agents work beside your tabs in one sidebar, the page sits in a clean white card, and blue appears only when Halo is involved.
colors:
  window-wash: "linear-gradient(160deg, #dfe6f5, #e6dcf0 70%, #f0dfe3) + radial #a8c7fa / #c58bff / #ffb98a"
  sidebar: "#ffffffa6"
  card: "#fcfcfd"
  surface: "#ffffff"
  well: "#f1f2f4"
  segment: "#eef0f3"
  hover: "#0000000a"
  line: "#0000001a"
  line-soft: "#0000000f"
  text: "#16181d"
  text-row: "#2a2e36"
  text-2: "#4d525c"
  text-3: "#8b909a"
  primary: "#16181d"
  on-primary: "#ffffff"
  accent: "#a8c7fa"
  accent-strong: "#2f6fd6"
  halo-on-bg: "#e8f0fe"
  halo-on-text: "#1f55b0"
  warning: "#b26a00"
  error: "#c86a64"
  success: "#72a982"
typography:
  display:
    fontFamily: "'Halo Display', 'Geist', -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    letterSpacing: 0.06em
    use: "The Halo wordmark and the Halo pill only"
  body:
    fontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', system-ui, sans-serif"
    fontSize: 13px
    lineHeight: 1.45
  label:
    fontSize: 11.5px
  mono:
    fontFamily: "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"
    fontFeature: tnum
rounded:
  control: 8px
  row: 9px
  card: 12px
  composer: 18px
  home-bar: 24px
  home-card: 16px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 32px
components:
  sidebar: { width: 248px, background: "{colors.sidebar}", blur: "36px saturate(1.6)" }
  main-card: { margin: "8px 8px 8px 0", rounded: "{rounded.card}", background: "{colors.card}", shadow: "0 0 0 1px #0000001a, 0 12px 40px #0002" }
  toolbar: { height: 48px, border-bottom: "{colors.line-soft}" }
  omnibox: { height: 34px, rounded: 10px, background: "{colors.well}", focus: "#fff + 2px {colors.accent} ring" }
  halo-pill: { height: 30px, rounded: 15px, font: display, on: "{colors.halo-on-bg} / {colors.halo-on-text}" }
  agent-panel: { width: 380px, background: "{colors.card}", border-left: "{colors.line-soft}", header: 46px }
  send-button: { size: 28px, rounded: full, background: "{colors.primary}" }
---

# Halo

## Overview

**Source:** Halo Design System, "Halo for Chromium" mock (`Halo Chromium.html`). The shipped implementation is `frontend/src/styles/chromium.css`, loaded last over `app.css` and `design-system/*`. When this file and the code disagree, fix one of them; do not let both drift.

**Creative North Star:** A bright desk by a window. The page sits on a clean white card; everything Halo adds (tabs, chats, agents) lives in one frosted sidebar on the left and one docked panel on the right. The room is calm until Halo is involved, and then the only blue in the chrome lights up.

**Product context:** Halo is a Chromium-based desktop browser with built-in AI agents. The first users are people who already left a mainstream browser because its agent stalled, hit CAPTCHAs, or ate memory. Beta is a limited public release in January.

**Mode per surface:** Operate (sidebar, toolbar, agent panel, approvals). Read (activity log, task results). The web page itself is the site's own surface and is never restyled; it keeps the OS light/dark preference (`main/page-theme.js`), independent of the light chrome.

**Memorable thing:** One sidebar holds Agents, Chats and Tabs together, and the Halo pill in the toolbar opens the agent beside the page, not over it.

**Key characteristics:**
- Light chrome on real glass: the window is translucent (vibrancy stays on), washed with a soft pastel gradient; the sidebar is frosted white over it.
- The page and home live in a white card with a 12px radius and a soft shadow; the toolbar is part of that card.
- Blue means Halo. It appears on the Halo pill only while its panel is open, on focus rings, and on the active-agent dot. Buttons are near-black, never blue.
- Status colors are small: a dot, glyph or short text. Amber means it needs you, red means blocked, green means done.

## Colors

**Strategy:** Restrained neutrals on a pastel glass wash, one brand hue. Light chrome only (`data-theme="light"` is forced in `main.tsx`); there is no dark chrome theme in this direction.

Text steps are `text` (#16181d) for primary, `text-row` (#2a2e36) for sidebar rows, `text-2` (#4d525c) for secondary and icons, `text-3` (#8b909a) for group labels, placeholders and meta. Wells (`well` #f1f2f4, `segment` #eef0f3) carry the omnibox and segmented controls; hover is `#0000000a`. Lines are black at 6–10% alpha, never solid grey. The primary action is the near-black `primary` with white text (send buttons). `accent` (#a8c7fa) is for focus rings; the open Halo pill uses `#e8f0fe` with `#1f55b0` text. Text on `card`, `surface` and the sidebar meets 4.5:1 for `text-2` and above; `text-3` is used only for non-essential meta and placeholders.

## Typography

Body text is Geist with the platform system sans as fallback. The renderer's CSP (`style-src 'self'`) blocks Google Fonts, so until a Geist file is bundled locally the UI renders in the system font (SF Pro on macOS). Halo Display (bundled at `frontend/src/styles/fonts/HaloDisplay.ttf`) is reserved for the Halo wordmark and the Halo pill, with 0.06em tracking; it is never used for body text or headings. Monospace (tabular numbers) is used only for URLs, selectors, amounts and log detail.

## Layout

The window is a horizontal row: sidebar (248px), then the main card (margin 8px 8px 8px 0).

- **Sidebar:** a 48px top row (traffic lights on the left on macOS, New tab and Hide sidebar on the right; the row is a drag region), a 32px search field ("Search tabs & chats"), then a scroll area with Agents, Chats, Tabs and Bookmarks in that order, and a footer with the saved-task count and Settings. Tabs are vertical by default (in the sidebar); the horizontal strip remains only as an explicit opt-in.
- **Main card:** the 48px toolbar (back, forward, reload, omnibox, Halo pill, Share, Show all tabs, Activity), then the page body. When the sidebar is hidden the toolbar gains "Show sidebar" and Settings buttons, and on macOS leaves 80px for the traffic lights.
- **Agent panel:** docked inside the card on the right, 380px (330px under 1120px). The native page view cannot draw under DOM overlays, so while the panel is open the page shows as a snapshot; this is a known limitation, not a design choice.
- **Home:** centered column up to 820px: a faded 64px Halo mark, the home bar (Search/Ask segmented control, Tab key toggles), then Chats/Routines and a 3-column card grid (2 under 1120px, 1 under 680px).
- **Responsive:** under 680px the sidebar hides and the card takes the full window with an 8px inset.

## Elevation & Depth

Three layers only: the translucent window wash, the frosted sidebar (`blur(36px) saturate(1.6)`), and the white card with `0 0 0 1px #0000001a, 0 12px 40px #0002`. Inside the card, depth is flat: 1px soft lines and white raised controls (`0 1px 2px #0000001f, 0 0 0 .5px #0000000f` for a selected sidebar row or segment). Popovers and the approval sheet float with a soft shadow; nothing uses a colored glow. Glass vibrancy stays on; it is part of the material, not decoration to trade for performance.

## Shapes

8px for icon buttons, 9px for sidebar rows and the search field, 10px for the omnibox, 12px for the main card, 16px for home cards, 18px for the chat composer, 24px for the home bar, full radius for pills, segmented controls, the send button and status dots.

## Components

- **Sidebar row:** 32px min height, 13px, `text-row`. Hover fills `hover`; selected is white with the raised shadow. Favicons sit in an 18px white tile.
- **Halo pill:** ring mark plus "Halo" in Halo Display. Transparent at rest, `#e8f0fe`/`#1f55b0` while the panel is open; the badge counts work that needs you.
- **Omnibox:** `well` at rest, white with a 2px `accent` ring on focus.
- **Home bar:** white, 24px radius, a 56px input row with a `Tab ⇄` hint and the Search/Ask segmented control; in Ask mode a tools row adds lock chips, the model picker and a 28px near-black send button.
- **Chat composer:** a white 18px pill, input on top, model picker, mic and send below. User messages are `segment` bubbles with a `16px 16px 4px 16px` radius; agent messages are plain text.
- **Approval sheet:** names the exact action and target (site, amount, currency). Primary = approve (near-black), secondary = decline. Irreversible actions are never approved by default.
- **States for every component:** hover, focus-visible, active, disabled, loading, empty, error, and long content are all designed.

## Do's and Don'ts

- Do keep Tabs behaviour identical to what Chrome/Arc users expect; put novelty in Agents and Chats.
- Do show agent state with a dot plus a text label; color never carries meaning alone.
- Do keep the page viewport untouched; Halo UI lives in the sidebar, the toolbar and the docked panel.
- Do keep payment and approval copy literal: site, amount, currency, and what happens next.
- Do keep motion under 300ms; exits shorter than enters.
- Don't use blue as a button fill; blue means Halo.
- Don't put card-inside-card layouts inside the main card.
- Don't fill a surface with `error` or `warning`.
- Don't turn off vibrancy or make the window wash opaque.
- Don't make the agent a floating chat bubble that covers the page by default.

## Motion

- **Easing:** enter `cubic-bezier(0.23, 1, 0.32, 1)`, exit ease-in, move ease-in-out.
- **Duration:** press 160ms, enter 220ms, exit 150ms; nothing over 300ms. Respect `prefers-reduced-motion` by replacing movement with opacity.
- **The one authored moment:** when an agent finishes a task or asks for approval, its status dot settles into its new color (220ms) and the row moves to its sorted position.

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-13 | Initial DESIGN.md created from shipped `tokens.css` plus product context | Code is the source of truth; `design-system/halo/MASTER.md` was an earlier direction and is superseded |
| 2026-10-13 | Dark chrome by default, system font, no gradients | Long sessions beside editors (superseded 2026-10-21) |
| 2026-10-13 | Neutral primary button, blue reserved for Halo | Keeps brand hue meaningful; still in force |
| 2026-10-13 | Tabs parity, Agents novelty | Adoption risk is in tab muscle memory; still in force |
| 2026-10-21 | Adopt the Halo Design System "Halo for Chromium" UI as-is: light chrome, pastel glass wash, Geist + Halo Display, one sidebar with Agents/Chats/Tabs, vertical tabs by default, docked 380px agent panel | Founder chose "새 디자인 그대로" over keeping the dark direction; the earlier UI and backend felt unintegrated |
| 2026-10-21 | Geist falls back to the system font for now | Renderer CSP blocks Google Fonts; bundling a local Geist file is a follow-up |
| 2026-10-21 | Character avatars are allowed in the agent area by the new design | The mock uses them; not yet implemented in the renderer |
