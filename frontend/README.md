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
| `src/components/` | `TabStrip`, `ControlBar`, `Toolbar`, `Viewport` (with Claude's target outline), `SessionPanel`, `Timeline`, `Confirmation`, `Logo`, `Icons`. |

## Interface rules

These rules come from the repository's `better-*` and `emil-design-eng` skills.

What's on screen is the web page, a quiet activity list, and a confirmation when one is needed. Everything else was removed; no function went with it.

- **Control, at the top:** *Claude has control* or *You have control*, with **Take control** or **Resume Claude**. While Claude waits for you it still has control, so the top row doesn't announce the wait. The confirmation in the panel does.
- **Activity:** one list of what Claude, You and Halo did.
  - Each row names the actor in bold text and says what happened in plain words: "Claude Filled shipping address", "Halo Blocked a tracking request", "You Approved $84.20". There are no avatars and no panel title.
  - "Done" is implicit. Only a pending ask gets a word ("Waiting").
  - Halo's rows are quieter system text. A blocked row has a 2px red bar and red text.
  - The policy verdict (`allow`, `review`, `quarantine`) is not printed; it's in the row's tooltip and in screen-reader text.
- **Confirmation:** a compact strip at the bottom of the panel, shown only while a decision is open.
  - "Place order for **$84.20**?", then the card and destination, then **Approve** and **Deny**.
  - The activity above it dims while it's open.
  - Focus goes to the question, not to Approve.
- **Claude's target on the page:** a thin muted-blue outline, with no label and no glow.
- **Per-tab status:** each tab Claude has worked in shows working / waiting / paused / done beside its favicon. Claude opens research tabs in the background.
- **Colour: near-black neutrals.** Layers are flat and separated by 1px lines. The web page keeps its own look.

  | Role | Value |
  | --- | --- |
  | App background, tab bar | `#0C0E0D` |
  | Toolbar, activity panel, confirmation | `#151816` |
  | Separators, tiles | `#292D2A` |
  | Control edges (3.1:1 or better) | `#666D67` |
  | Primary text | `#E7E8E4` |
  | Secondary text | `#858C86` |
  | Halo accent, ice: brand, focus, Claude's cursor | `#A8C7FA` (`#3B6FC4` on the light page) |
  | Approval (dot only) | `#B99752` |
  | Blocked (2px left bar plus text, never a filled surface) | `#C86A64` |
  | Success (glyph) | `#72A982` |

  - Status is carried by a small dot, a glyph or a few words of text.
  - The primary button is a neutral light fill, not a hue.
- **Type:**
  - SF / Inter sans everywhere.
  - Monospace is used only for URLs and log detail: selectors, hosts and requests.
  - Uppercase appears only on the small policy labels.
- **Keyboard and screen reader**
  - Every control is a native `<button>`.
  - Tabs follow the ARIA tabs pattern: ← → Home End move between tabs, and Delete closes one.
  - A skip link jumps to the page.
  - A polite live region announces control changes.
  - When a confirmation appears, focus goes to its question, never to the approve button.
- **Motion:** only when the user hasn't asked for reduced motion; animates only transform and opacity; buttons press to `scale(0.96)`; new rows and the confirmation fade in over 220ms.
- **Layout**
  - The activity panel is 340–400px wide on desktop.
  - Below 45rem it stacks under the page.
  - Below 40rem the control row takes the top line on its own.
  - At 320px there is no horizontal scroll.

## Demo data

The UI runs on a scripted session (`demoSession` in `src/session/session.ts`), labelled **Demo** in the Session panel. It isn't connected to the HALO gateway yet. To connect it, feed gateway steps and verdicts in as `PlannedStep`s and send Approve and Deny to the gateway's `/approve` endpoint.

The viewport is a stand-in for a real page engine. It draws a sample checkout page and Claude's cursor on the element Claude is about to use.
