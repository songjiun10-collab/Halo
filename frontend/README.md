# HALO frontend

The HALO browser UI: an AI agent drives the browser, and you supervise it. Each agent step shows the gateway's verdict (`allow`, `review`, `deny`, `quarantine`). A `review` step pauses the agent until you approve or deny it.

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
| `src/session/` | Session model and reducer: tabs with per-tab history, agent state, step log, pending approval; stand-in page titles. |
| `src/components/` | `TabStrip`, `Toolbar`, `Viewport`, `AgentPanel`, `ApprovalPrompt`, `VerdictBadge`, `AgentStatus`, `Icons`. |

## Interface rules

These rules come from the repository's `better-*` and `emil-design-eng` skills.

- **Keyboard**
  - Every control is a native `<button>`, and every icon-only button has a label.
  - Tabs follow the ARIA tabs pattern: ← → Home End move between tabs, and Delete closes one.
  - A skip link jumps to the page.
  - When a review step appears, focus goes to its question, never to the approve button.
- **You and the agent**
  - While the agent holds its tab, you can't navigate or close that tab. Pause the agent first.
  - Pause is reversible, so it uses a neutral button, not the danger colour.
- **Colour meanings**
  - Green means go: the agent is working, `allow`, and the one primary action.
  - Amber means the agent needs you. It is used at full strength only on the approval card; past steps show their verdict quietly (muted word, coloured glyph).
  - Red means denied.
  - Violet means held back (`quarantine`).
  - A verdict always shows its word and a glyph, never colour alone.
- **Motion**
  - Motion is opt-in (`prefers-reduced-motion: no-preference`) and animates only transform and opacity.
  - Buttons press to `scale(0.96)`. New steps and the approval prompt enter over 220ms with a strong ease-out.
- **Chrome**
  - One surface for tabs and toolbar, with the HALO mark at the start, pill tabs, and Back/Forward only (no Reload).
- **Layout**
  - The Agent panel is 340–400px wide on desktop.
  - Below 45rem, the Agent panel stacks under the page.
  - Below 35rem, the address field moves to its own row.
  - At 320px there is no horizontal scroll.

## Demo data

The UI runs on a scripted session (`demoSession` in `src/session/session.ts`) and is labelled **DEMO SESSION**. It isn't connected to the HALO gateway yet. To connect it, feed real steps and verdicts into the same `SessionState` shape and send Approve and Deny to the gateway's `/approve` endpoint.

The viewport is a stand-in for a real page engine. It draws a sample checkout page and the "Agent target" outline around the element the agent is about to use.
