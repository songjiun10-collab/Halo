# HALO frontend

HALO is a browser that you and Claude share. Claude drives it and you can take over at any time. Halo is the third party: it supervises what Claude does and blocks anything policy doesn't allow. When an action needs you, Halo asks you to approve it.

Built with Vite, React and TypeScript on the HALO design system. The design system uses the ui-ux-pro-max "Developer Tool / Dark Mode (OLED)" direction; its master is `../design-system/halo/MASTER.md`.

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # type-check + production build to dist/
npm run lint
```

## Structure

| Path | What |
| --- | --- |
| `src/styles/tokens.css` | Design tokens (colours, type, spacing, radii, shadows). Mirrors the design system's `tokens.json`. |
| `src/styles/app.css` | Component styles, ported from the design system's `bundle.css`. |
| `src/session/` | Session model and reducer: who has control, tabs with per-tab history and Claude's per-tab state, the shared timeline, the pending approval; stand-in page titles. |
| `src/components/` | `TabStrip`, `Toolbar`, `TabOverview`, `ControllerChip`, `HaloButton`, `Viewport` (halo ring, target outline), `HaloSheet`, `Notice`, `Activity`, `Logo`, `Icons`. |

## Interface rules

The page is the product. Halo stays quiet while the agent works, and appears only when something needs a person: something was blocked, an approval is needed, or control changes hands. These rules come from the repository's `better-*` and `emil-design-eng` skills.

- **A browser first.** There is no permanent side panel: the page takes the full width. Tabs and the address field are full browser size. The toolbar has Back, Forward, the address field, **Share** (the system share sheet, or copies the link where sharing isn't available), **Show all tabs** (a Safari-style grid of tab cards that shows the agent's state per tab; Esc closes it) and **New window**.
- **Folded by default.** When nothing needs a person, Halo shows nothing: no chip, no Halo button, no page edge. The agent's tab keeps only its small mark beside the favicon. Halo unfolds for:
  - a block,
  - an approval,
  - control you took over (so **Resume** is visible),
  - unseen events.

  Hovering the toolbar or moving keyboard focus into it also unfolds it, so **Take over** is always one step away. ⌘/Ctrl + . keeps it unfolded.
- **Who is driving lives in the address field.** A chip at the end of the address field says *Agent is browsing*, *Agent is waiting for you* or *Resume agent*. One click hands control over (**Take over**). The chrome says "Agent"; the agent's name ("Claude") appears only in details, so the UI works for any agent.
- **The halo edge.** While the agent drives a tab, the page has a faint 1px ice edge. When you drive, there is none. It's a quiet cue; the chip in the address field says it in words.
- **One place per state.** An approval is a permission sheet dropped from the address bar. It's the only place the pending decision is described: the action, the amount (large), the card, the destination, then **Deny** / **Approve $84.20**, and the exact request in small mono text. Focus goes to the question, not to Approve.
- **Blocks are brief.** A Halo block is a small notice in the same spot, with a light shadow: a 2px red bar, the blocked host in red, and **Details**. It disappears after 6 seconds and stays in Activity.
- **Activity on request.** The Halo ring button in the toolbar shows a count of new notable events. It has a tooltip ("Halo events · 1 new") on hover and keyboard focus. Opening it lists only what mattered: blocks, asks, answers, handoffs and finishing. The agent's step-by-step trace is folded under **All steps**. Policy verdicts are in tooltips and screen-reader text. Esc closes the list.
- **Colour:** near-black neutrals with flat layers. The web page keeps its own look.

  | Role | Value |
  | --- | --- |
  | App background, tab bar, address field | `#0C0E0D` |
  | Toolbar, selected tab, sheets | `#151816` |
  | Separators, tiles | `#292D2A` |
  | Control edges (3.1:1 or better) | `#666D67` |
  | Primary text | `#E7E8E4` |
  | Secondary text | `#858C86` |
  | Halo accent, ice: the ring, the halo, focus | `#A8C7FA` (`#3B6FC4` for the target outline on the light page) |
  | Waiting for approval (dot) | `#B99752` |
  | Blocked (2px bar and text) | `#C86A64` |
  | Success | `#72A982` |

  Status is shown with a dot, a glyph or a few words. The primary button is a neutral light fill.
- **Type:** SF / Inter sans. Monospace is used only for URLs and log detail.
- **Per-tab status:** each tab the agent has used shows a mark beside its favicon: working (ice dot), waiting (Ⅱ amber), paused (Ⅱ) or done (✓). The agent opens research tabs in the background, so your view stays put.
- **Keyboard and screen reader**
  - Every control is a native `<button>`.
  - Tabs follow the ARIA tabs pattern: ← → Home End move between tabs, and Delete closes one.
  - A skip link jumps to the page.
  - A polite live region announces who is browsing and when Halo pauses for an approval.
- **Motion:** only when the user hasn't asked for reduced motion; animates only transform and opacity. Sheets drop in over 220ms; buttons press to `scale(0.96)`.
- **Layout:** below 40rem, Share and New window are hidden, the chip shows only **Take over**, sheets span the width, and 320px has no horizontal scroll.

## Demo data

The UI runs on a scripted session (`demoSession` in `src/session/session.ts`), labelled **Demo** in Activity. It isn't connected to the HALO gateway yet. To connect it, feed gateway steps and verdicts in as `PlannedStep`s and send Approve and Deny to the gateway's `/approve` endpoint.

The viewport is a stand-in for a real page engine. It draws a sample checkout page and Claude's cursor on the element Claude is about to use.
