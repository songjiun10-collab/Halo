import { useEffect, useReducer } from 'react'
import { ControlBar } from './components/ControlBar'
import { SessionPanel } from './components/SessionPanel'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { AGENT, claudeHolds, controlLabel, demoSession, reducer } from './session/session'
import type { SessionState } from './session/types'

const STEP_MS = 1600

/** One sentence per control change for the polite live region. */
function announcement(s: SessionState) {
  if (s.control === 'approval' && s.pending?.approval) return `Approval needed: ${AGENT} wants to ${s.pending.approval.action.toLowerCase()} for ${s.pending.approval.amount}`
  if (s.control === 'you' && s.finished) return `${AGENT} finished. You have control.`
  return controlLabel[s.control]
}

export default function App() {
  const [s, dispatch] = useReducer(reducer, undefined, demoSession)

  // Advance the scripted session while Claude has control.
  useEffect(() => {
    if (s.control !== 'claude') return
    const id = window.setTimeout(() => dispatch({ type: 'tick' }), STEP_MS)
    return () => window.clearTimeout(id)
  }, [s.control, s.timeline.length])

  const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
  const pendingHere = s.control === 'approval' && s.pending && s.tabKeys[s.pending.tab] === tab.id

  return (
    <div className="hx-app">
      <a className="hx-skip" href="#hx-page">Skip to page</a>
      <h1 className="hx-sr">HALO</h1>
      <p className="hx-sr" role="status" aria-live="polite">{announcement(s)}</p>
      <div className="hx-window">
        <header className="hx-chrome">
          <TabStrip
            tabs={s.tabs}
            activeTabId={tab.id}
            canClose={(t) => !claudeHolds(s, t)}
            onSelect={(id) => dispatch({ type: 'selectTab', id })}
            onClose={(id) => dispatch({ type: 'closeTab', id })}
            onNew={() => dispatch({ type: 'newTab' })}
            trailing={
              <ControlBar
                control={s.control}
                finished={s.finished}
                onTakeControl={() => dispatch({ type: 'takeControl' })}
                onResume={() => dispatch({ type: 'resume' })}
              />
            }
          />
          <Toolbar tab={tab} locked={claudeHolds(s, tab)} onBack={() => dispatch({ type: 'back' })} onForward={() => dispatch({ type: 'forward' })} />
        </header>
        <div className="hx-body">
          <Viewport tab={tab} target={pendingHere ? s.pending?.target : undefined} />
          <SessionPanel session={s} onApprove={() => dispatch({ type: 'approve' })} onDeny={() => dispatch({ type: 'deny' })} />
        </div>
      </div>
    </div>
  )
}
