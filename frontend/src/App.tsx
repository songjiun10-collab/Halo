import { useCallback, useEffect, useReducer, useState } from 'react'
import { Activity } from './components/Activity'
import { ControllerChip } from './components/ControllerChip'
import { HaloButton } from './components/HaloButton'
import { HaloSheet } from './components/HaloSheet'
import { Notice } from './components/Notice'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { AGENT, claudeHolds, demoSession, reducer } from './session/session'
import type { SessionState, TimelineEvent } from './session/types'

const STEP_MS = 1600
const NOTICE_MS = 6000

/** One sentence per control change for the polite live region. */
function announcement(s: SessionState) {
  if (s.control === 'approval' && s.pending?.approval) return `Halo paused ${AGENT}: approve ${s.pending.approval.action.toLowerCase()} for ${s.pending.approval.amount}?`
  if (s.control === 'you') return s.finished ? `${AGENT} finished. You are browsing.` : 'You are browsing.'
  return `${AGENT} is browsing.`
}

export default function App() {
  const [s, dispatch] = useReducer(reducer, undefined, demoSession)
  const [activityOpen, setActivityOpen] = useState(false)
  const [seen, setSeen] = useState(0)
  const [dismissedNotice, setDismissedNotice] = useState<number | null>(null)

  // Advance the scripted session while the agent is browsing.
  useEffect(() => {
    if (s.control !== 'claude') return
    const id = window.setTimeout(() => dispatch({ type: 'tick' }), STEP_MS)
    return () => window.clearTimeout(id)
  }, [s.control, s.timeline.length])

  // A Halo block needs no answer: show it briefly, then it lives in Activity.
  const last = s.timeline[s.timeline.length - 1]
  const notice: TimelineEvent | null = last && last.actor === 'halo' && last.id !== dismissedNotice ? last : null
  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setDismissedNotice(notice.id), NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [notice])

  const notableCount = s.timeline.filter((e) => e.notable).length
  const openActivity = useCallback(() => { setActivityOpen(true); setSeen(notableCount); if (last) setDismissedNotice(last.id) }, [notableCount, last])
  const closeActivity = useCallback(() => { setActivityOpen(false); setSeen(notableCount) }, [notableCount])

  const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
  const pendingHere = s.control === 'approval' && s.pending && s.tabKeys[s.pending.tab] === tab.id
  const driven = s.control !== 'you' && (tab.claude === 'working' || tab.claude === 'waiting')
  const approval = s.control === 'approval' ? s.pending?.approval : undefined

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
          />
          <Toolbar
            tab={tab}
            locked={claudeHolds(s, tab)}
            onBack={() => dispatch({ type: 'back' })}
            onForward={() => dispatch({ type: 'forward' })}
            controller={
              <ControllerChip
                control={s.control}
                finished={s.finished}
                onTakeOver={() => dispatch({ type: 'takeControl' })}
                onResume={() => dispatch({ type: 'resume' })}
              />
            }
            halo={<HaloButton unseen={Math.max(0, notableCount - seen)} open={activityOpen} onToggle={activityOpen ? closeActivity : openActivity} />}
          />
        </header>
        <div className="hx-body">
          <Viewport tab={tab} target={pendingHere ? s.pending?.target : undefined} driven={driven} />
          <div className="hx-overlays">
            {approval && <HaloSheet approval={approval} onApprove={() => dispatch({ type: 'approve' })} onDeny={() => dispatch({ type: 'deny' })} />}
            {!approval && notice && !activityOpen && <Notice event={notice} onOpen={openActivity} />}
            {activityOpen && <Activity session={s} onClose={closeActivity} />}
          </div>
        </div>
      </div>
    </div>
  )
}
