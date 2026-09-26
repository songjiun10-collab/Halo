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
| `src/components/` | `TabStrip`, `ControlBar`, `Toolbar`, `Viewport` (with Claude's cursor), `SessionPanel`, `Timeline`, `ApprovalCard`, `Logo`, `Icons`. |

## Interface rules

These rules come from the repository's `better-*` and `emil-design-eng` skills.

- **Control is stated at the top.** The top row says *Claude has control*, *Approval needed* or *You have control*, with the one action that changes it beside it:
  - **Take control** hands the browser to you. It is not "pause": you carry on the task yourself.
  - **Resume Claude** hands it back.
- **One shared timeline.** The *Session* panel records what each party did, in plain words:
  - Claude: "Filled shipping address"
  - Halo: "Blocked a tracking request"
  - You: "Approved $84.20"
  - The main status is *Done*, *Blocked*, *Needs approval*, *Approved* or *Denied*. The policy verdict (`ALLOW`, `QUARANTINE`, `REVIEW`) is small secondary text.
- **Colour: 85–90% neutral.** Graphite chrome, a slightly lighter sidebar, low-chroma grey borders; the web page keeps its own look. Hue only carries meaning:
  - Halo blue: brand (the logo), selection (the selected-tab underline, Claude's cursor on the page) and focus rings. Never decoration.
  - Green: success (Done, Approved).
  - Amber: needs approval.
  - Red: blocked or danger.
  - The primary button is neutral (light fill, dark text), not a hue.
- **The approval card is the focus.**
  - It lists the amount first, then the card, then the destination.
  - While it's open, the timeline above it is dimmed. The text stays at readable contrast.
  - Amber appears at full strength only on this card and the top-row state.
- **Claude's cursor.** On the page, the element Claude is about to use gets a soft Halo-blue ring and a cursor labelled "Claude", like a collaborator's pointer.
- **Per-tab status.** Each tab Claude has worked in shows its state next to the favicon: working (dot), waiting (Ⅱ amber), paused (Ⅱ grey) or done (green ✓).
  - Claude opens research tabs in the background, so your view stays where it is.
  - You can't navigate or close a tab while Claude holds it.
- **Keyboard and screen reader**
  - Every control is a native `<button>`.
  - Tabs follow the ARIA tabs pattern: ← → Home End move between tabs, and Delete closes one.
  - A skip link jumps to the page.
  - A polite live region announces control changes.
  - When an approval appears, focus goes to the amount, never to the approve button.
- **Motion:** only when the user hasn't asked for reduced motion; animates only transform and opacity; buttons press to `scale(0.96)`; new events fade in over 220ms.
- **Layout**
  - The Session panel is 340–400px wide on desktop.
  - Below 45rem it stacks under the page.
  - Below 40rem the control row takes the top line on its own.
  - At 320px there is no horizontal scroll.

## Demo data

The UI runs on a scripted session (`demoSession` in `src/session/session.ts`), labelled **Demo** in the Session panel. It isn't connected to the HALO gateway yet. To connect it, feed gateway steps and verdicts in as `PlannedStep`s and send Approve and Deny to the gateway's `/approve` endpoint.

The viewport is a stand-in for a real page engine. It draws a sample checkout page and Claude's cursor on the element Claude is about to use.
