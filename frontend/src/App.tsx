import { useCallback, useEffect, useReducer, useState } from 'react'
import { Activity } from './components/Activity'
import { ControllerChip } from './components/ControllerChip'
import { HaloButton } from './components/HaloButton'
import { HaloSheet } from './components/HaloSheet'
import { Notice } from './components/Notice'
import { TabOverview } from './components/TabOverview'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { AGENT, claudeHolds, currentUrl, demoSession, reducer } from './session/session'
import { pageTitle } from './session/pages'
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
  /** ⌘/Ctrl + . keeps Halo's controls unfolded even when nothing needs you. */
  const [pinned, setPinned] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(id)
  }, [toast])
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); setPinned((p) => !p) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const unseen = Math.max(0, notableCount - seen)
  // Folded: nothing needs a person, so Halo shows nothing at all — just the browser.
  // It unfolds for a block, an approval, a handoff back, unseen events, or on hover / keyboard focus in the toolbar.
  const needsYou = s.control === 'approval' || (s.control === 'you' && !s.finished)
  const folded = !pinned && !activityOpen && !notice && unseen === 0 && !needsYou

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
        <header className="hx-chrome" inert={overviewOpen}>
          <TabStrip
            tabs={s.tabs}
            activeTabId={tab.id}
            canClose={(t) => !claudeHolds(s, t)}
            onSelect={(id) => dispatch({ type: 'selectTab', id })}
            onClose={(id) => dispatch({ type: 'closeTab', id })}
            onNew={() => dispatch({ type: 'newTab' })}
          />
          <Toolbar
            folded={folded}
            tab={tab}
            locked={claudeHolds(s, tab)}
            onBack={() => dispatch({ type: 'back' })}
            onForward={() => dispatch({ type: 'forward' })}
            onShare={async () => {
              const url = currentUrl(tab)
              try {
                if (navigator.share) await navigator.share({ title: pageTitle(url), url })
                else { await navigator.clipboard.writeText(url); setToast('Link copied') }
              } catch (err) {
                if ((err as DOMException)?.name !== 'AbortError') setToast('Unable to share this page')
              }
            }}
            onOverview={() => setOverviewOpen(true)}
            onNewWindow={() => { window.open(window.location.href, '_blank', 'noopener,width=1280,height=800') }}
            controller={
              <ControllerChip
                control={s.control}
                finished={s.finished}
                onTakeOver={() => dispatch({ type: 'takeControl' })}
                onResume={() => dispatch({ type: 'resume' })}
              />
            }
            halo={<HaloButton unseen={unseen} open={activityOpen} onToggle={activityOpen ? closeActivity : openActivity} />}
          />
        </header>
        <div className="hx-body" inert={overviewOpen}>
          <Viewport tab={tab} target={pendingHere ? s.pending?.target : undefined} driven={driven && !folded} />
          <div className="hx-overlays">
            {approval && <HaloSheet approval={approval} onApprove={() => dispatch({ type: 'approve' })} onDeny={() => dispatch({ type: 'deny' })} />}
            {!approval && notice && !activityOpen && <Notice event={notice} onOpen={openActivity} />}
            {activityOpen && <Activity session={s} onClose={closeActivity} />}
            {toast && <p className="hx-toast" role="status">{toast}</p>}
          </div>

        </div>
        {overviewOpen && (
          <TabOverview
            tabs={s.tabs}
            activeTabId={tab.id}
            onPick={(id) => { dispatch({ type: 'selectTab', id }); setOverviewOpen(false) }}
            onClose={() => setOverviewOpen(false)}
          />
        )}
      </div>
    </div>
  )
}
