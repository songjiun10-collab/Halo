import { useEffect, useReducer } from 'react'
import { AgentPanel } from './components/AgentPanel'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { demoSession, reducer } from './session/session'

const STEP_MS = 1600

export default function App() {
  const [s, dispatch] = useReducer(reducer, undefined, () => demoSession(Date.now()))

  // Advance the scripted agent while it is acting.
  useEffect(() => {
    if (s.agent !== 'acting') return
    const id = window.setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), STEP_MS)
    return () => window.clearTimeout(id)
  }, [s.agent, s.log.length])

  const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
  const last = s.log[s.log.length - 1]
  const pageVerdict = tab.agent ? (s.pending ? 'review' : last?.verdict) : undefined
  const target = tab.agent ? s.pending?.target : undefined

  return (
    <div className="hx-app">
      <div className="hx-win">
        <TabStrip
          tabs={s.tabs}
          activeTabId={tab.id}
          agent={s.agent}
          onSelect={(id) => dispatch({ type: 'selectTab', id })}
          onClose={(id) => dispatch({ type: 'closeTab', id })}
          onNew={() => dispatch({ type: 'newTab' })}
        />
        <Toolbar
          tab={tab}
          pageVerdict={pageVerdict}
          agent={s.agent}
          onStop={() => dispatch({ type: 'stop', now: Date.now() })}
          onResume={() => dispatch({ type: 'resume', now: Date.now() })}
        />
        <div className="hx-body">
          <Viewport tab={tab} target={target} />
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
