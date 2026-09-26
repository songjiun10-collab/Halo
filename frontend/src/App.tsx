import { useEffect, useReducer } from 'react'
import { AgentPanel } from './components/AgentPanel'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { agentHolds, demoSession, reducer } from './session/session'
import type { SessionState } from './session/types'

const STEP_MS = 1600

/** One sentence per state change for the polite live region. */
function announcement(s: SessionState) {
  if (s.agent === 'waiting' && s.pending) return `Step ${s.pending.n} needs your review: ${s.pending.prompt?.title ?? s.pending.title}`
  if (s.agent === 'stopped') return 'Agent paused'
  if (s.agent === 'idle') return `Agent finished after ${s.log.length} steps`
  return ''
}

export default function App() {
  const [s, dispatch] = useReducer(reducer, undefined, () => demoSession(Date.now()))

  // Advance the scripted agent while it is working.
  useEffect(() => {
    if (s.agent !== 'acting') return
    const id = window.setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), STEP_MS)
    return () => window.clearTimeout(id)
  }, [s.agent, s.log.length])

  const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
  const locked = agentHolds(s, tab)

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
          agent={s.agent}
          canClose={(t) => !agentHolds(s, t)}
          onSelect={(id) => dispatch({ type: 'selectTab', id })}
          onClose={(id) => dispatch({ type: 'closeTab', id })}
          onNew={() => dispatch({ type: 'newTab' })}
        />
        <Toolbar
          tab={tab}
          locked={locked}
          agent={s.agent}
          onBack={() => dispatch({ type: 'back' })}
          onForward={() => dispatch({ type: 'forward' })}
          onPause={() => dispatch({ type: 'pause', now: Date.now() })}
          onResume={() => dispatch({ type: 'resume', now: Date.now() })}
        />
        </header>
        <div className="hx-body">
          <Viewport tab={tab} target={tab.agent ? s.pending?.target : undefined} />
          <AgentPanel
            session={s}
            onApprove={() => dispatch({ type: 'approve', now: Date.now() })}
            onDeny={() => dispatch({ type: 'deny', now: Date.now() })}
          />
        </div>
      </div>
    </div>
  )
}
