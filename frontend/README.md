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
| `src/session/` | Session model and reducer: tabs, agent state, step log, pending approval. |
| `src/components/` | `TabStrip`, `Toolbar`, `Viewport`, `AgentPanel`, `ApprovalPrompt`, `VerdictBadge`, `AgentDot`, `Icons`. |

## Demo data

The UI runs on a scripted session (`demoSession` in `src/session/session.ts`) and is labelled **DEMO SESSION**. It isn't connected to the HALO gateway yet. To connect it, feed real steps and verdicts into the same `SessionState` shape and send Approve and Deny to the gateway's `/approve` endpoint.

The viewport is a stand-in for a real page engine. It draws a sample checkout page and the "Agent target" outline around the element the agent is about to use.
