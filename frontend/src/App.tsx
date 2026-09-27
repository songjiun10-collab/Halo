import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Activity } from './components/Activity'
import { ControllerChip } from './components/ControllerChip'
import { HaloButton } from './components/HaloButton'
import { HaloSheet } from './components/HaloSheet'
import { Notice } from './components/Notice'
import { ShortcutsHelp } from './components/ShortcutsHelp'
import { TabOverview } from './components/TabOverview'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { usePresence } from './hooks/usePresence'
import { useShortcuts } from './hooks/useShortcuts'
import { useTrackpad } from './hooks/useTrackpad'
import { AGENT, approvalFor, canCloseTab, claudeHolds, currentUrl, demoSession, reducer } from './session/session'
import { tabTitle } from './session/pages'
import type { SessionState, TimelineEvent } from './session/types'

const STEP_MS = 1600
const NOTICE_MS = 6000

/** One sentence per change for the polite live region, including Halo's blocks. */
function announcement(s: SessionState, notice: TimelineEvent | null) {
  if (s.control === 'approval' && s.pending) {
    const a = approvalFor(s.pending)
    return `Halo paused ${AGENT}: approve ${a.action.toLowerCase()}${a.amount ? ` for ${a.amount}` : ''}?`
  }
  if (notice) return `Halo ${notice.text.charAt(0).toLowerCase()}${notice.text.slice(1)}${notice.detail ? ` to ${notice.detail}` : ''}.`
  if (s.control === 'you') return s.finished ? `${AGENT} finished. You are browsing.` : 'You are browsing.'
  return `${AGENT} is browsing.`
}

export default function App() {
  const [s, dispatch] = useReducer(reducer, undefined, demoSession)
  const [activityOpen, setActivityOpen] = useState(false)
  /** ⌘/Ctrl + . keeps Halo's controls unfolded even when nothing needs you. */
  const [pinned, setPinned] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const omniRef = useRef<HTMLDivElement>(null)
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

  // A Halo block needs no answer: show it for NOTICE_MS (even as the agent keeps working), then it lives in Activity.
  const lastBlock = useMemo(() => [...s.timeline].reverse().find((e) => e.actor === 'halo') ?? null, [s.timeline])
  const notice: TimelineEvent | null = lastBlock && lastBlock.id !== dismissedNotice ? lastBlock : null
  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setDismissedNotice(notice.id), NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [notice])

  const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
  // Every review step gets a usable sheet, with or without payment details.
  const approval = useMemo(() => (s.control === 'approval' && s.pending ? approvalFor(s.pending) : undefined), [s.control, s.pending])

  const notableCount = s.timeline.filter((e) => e.notable).length
  const openActivity = useCallback(() => {
    setActivityOpen(true); setOverviewOpen(false); setHelpOpen(false)
    setSeen(notableCount); if (lastBlock) setDismissedNotice(lastBlock.id)
  }, [notableCount, lastBlock])
  const closeOverview = useCallback(() => setOverviewOpen(false), [])
  const closeActivity = useCallback(() => { setActivityOpen(false); setSeen(notableCount) }, [notableCount])
  const toggleActivity = useCallback(() => { if (activityOpen) closeActivity(); else openActivity() }, [activityOpen, closeActivity, openActivity])
  const toggleOverview = useCallback(() => {
    setOverviewOpen((o) => {
      if (!o) { setActivityOpen(false); setHelpOpen(false) }
      return !o
    })
  }, [])
  const toggleHelp = useCallback(() => {
    setHelpOpen((h) => {
      if (!h) { setActivityOpen(false); setOverviewOpen(false) }
      return !h
    })
  }, [])

  const onShare = useCallback(async () => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0]
    const url = currentUrl(tab)
    try {
      if (navigator.share) await navigator.share({ title: tabTitle(tab), url })
      else { await navigator.clipboard.writeText(url); setToast('Link copied') }
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setToast('Unable to share this page')
    }
  }, [s.tabs, s.activeTabId])
  const onNewWindow = useCallback(() => {
    window.open(window.location.href, '_blank', 'noopener,width=1280,height=800')
  }, [])

  const shortcutHandlers = useMemo(() => ({
    onNewTab: () => dispatch({ type: 'newTab' }),
    onCloseTab: (id: string) => dispatch({ type: 'closeTab', id }),
    onSelectTab: (id: string) => dispatch({ type: 'selectTab', id }),
    onBack: () => dispatch({ type: 'back' }),
    onForward: () => dispatch({ type: 'forward' }),
    onFocusOmni: () => omniRef.current?.focus(),
    onTogglePin: () => setPinned((p) => !p),
    onToggleActivity: toggleActivity,
    onToggleOverview: toggleOverview,
    onNewWindow,
    onShare,
    onToggleHelp: toggleHelp,
  }), [dispatch, toggleActivity, toggleOverview, onNewWindow, onShare, toggleHelp])
  useShortcuts(s, approval, shortcutHandlers)

  const trackpadHandlers = useMemo(() => ({
    onBack: () => dispatch({ type: 'back' }),
    onForward: () => dispatch({ type: 'forward' }),
    onToggleOverview: toggleOverview,
  }), [dispatch, toggleOverview])
  useTrackpad(!approval, overviewOpen, trackpadHandlers)

  const unseen = Math.max(0, notableCount - seen)
  // Folded: nothing needs a person, so Halo shows nothing at all — just the browser.
  // It unfolds for a block, an approval, a handoff back, unseen events, or on hover / keyboard focus in the toolbar.
  const needsYou = s.control === 'approval' || (s.control === 'you' && !s.finished)
  const folded = !pinned && !activityOpen && !notice && unseen === 0 && !needsYou


  const pendingHere = s.control === 'approval' && s.pending && s.tabKeys[s.pending.tab] === tab.id
  const driven = s.control !== 'you' && (tab.claude === 'working' || tab.claude === 'waiting')

  // The approval sheet is modal: while it's open the rest of the window is inert, and focus
  // returns to where it was once the decision is made.
  // A layout effect, so this reads focus before HaloSheet's own effect moves it to the sheet title.
  const beforeSheet = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (!approval) return
    beforeSheet.current = document.activeElement as HTMLElement | null
    return () => {
      // Back to where you were; if that was nowhere, to the control that now matters (Resume) or the page.
      const back = beforeSheet.current
      const usable = back && back !== document.body && back.isConnected && !back.closest('.hx-sheet')
      const target = usable ? back : document.querySelector<HTMLElement>('.hx-chip') ?? document.getElementById('hx-page')
      target?.focus()
    }
  }, [approval])

  // An approval takes precedence over the tab overview: the sheet lives in .hx-body, which the overview makes inert.
  // Adjusted during render (like usePresence) so the overview never commits on top of a new sheet.
  if (approval && overviewOpen) setOverviewOpen(false)
  if (approval && helpOpen) setHelpOpen(false)
  // At the moment of a decision, show only the decision: Activity closes rather than stack behind the sheet.
  if (approval && activityOpen) { setActivityOpen(false); setSeen(notableCount) }

  // Overlays stay mounted briefly after they're dismissed so they can animate out.
  const sheet = usePresence(approval ?? null)
  const noticeShown = usePresence(notice && !activityOpen && !approval ? notice : null)
  const activityShown = usePresence(activityOpen ? true : null)
  const toastShown = usePresence(toast)
  const overviewShown = usePresence(overviewOpen ? true : null)
  const helpShown = usePresence(helpOpen ? true : null)

  return (
    <div className="hx-app">
      <a className="hx-skip" href="#hx-page" inert={!!approval}>Skip to page</a>
      <h1 className="hx-sr">HALO</h1>
      <p className="hx-sr" role="status" aria-live="polite">{announcement(s, notice)}</p>
      <div className="hx-window">
        <header className="hx-chrome" inert={overviewOpen || !!approval}>
          <TabStrip
            tabs={s.tabs}
            activeTabId={tab.id}
            canClose={(t) => canCloseTab(s, t)}
            onSelect={(id) => dispatch({ type: 'selectTab', id })}
            onClose={(id) => dispatch({ type: 'closeTab', id })}
            onNew={() => dispatch({ type: 'newTab' })}
          />
          <Toolbar
            folded={folded}
            tab={tab}
            locked={claudeHolds(s, tab)}
            omniRef={omniRef}
            onBack={() => dispatch({ type: 'back' })}
            onForward={() => dispatch({ type: 'forward' })}
            onShare={onShare}
            onOverview={toggleOverview}
            onNewWindow={onNewWindow}
            onHelp={toggleHelp}
            controller={
              <ControllerChip
                control={s.control}
                finished={s.finished}
                onTakeOver={() => dispatch({ type: 'takeControl' })}
                onResume={() => dispatch({ type: 'resume' })}
              />
            }
            halo={<HaloButton unseen={unseen} open={activityOpen} onToggle={toggleActivity} />}
          />
        </header>
        <div className="hx-body" inert={overviewOpen}>
          <div className="hx-page" inert={!!approval}>
            <Viewport tab={tab} target={pendingHere ? s.pending?.target : undefined} driven={driven && !folded} />
            <div className="hx-edge" data-on={(driven && !folded) || undefined} aria-hidden="true" />
          </div>
          {/* One Halo surface at a time: a surface a newer one supersedes cuts instantly rather
              than cross-fading underneath it, so the glass never stacks two deep. */}
          <div className="hx-overlays">
            {sheet.item && <HaloSheet approval={sheet.item} leaving={sheet.leaving} onApprove={() => dispatch({ type: 'approve' })} onDeny={() => dispatch({ type: 'deny' })} onTakeOver={() => dispatch({ type: 'takeControl' })} />}
            {noticeShown.item && !activityOpen && !approval && <Notice event={noticeShown.item} leaving={noticeShown.leaving} blocked={!!approval} onOpen={openActivity} />}
            {activityShown.item && !approval && !overviewOpen && !helpOpen && <Activity session={s} leaving={activityShown.leaving} onClose={closeActivity} />}
            {helpShown.item && !approval && !activityOpen && !overviewOpen && <ShortcutsHelp leaving={helpShown.leaving} onClose={() => setHelpOpen(false)} />}
            {toastShown.item && <p className="hx-toast" role="status" data-leaving={toastShown.leaving || undefined}>{toastShown.item}</p>}
          </div>

        </div>
        {overviewShown.item && !approval && !activityOpen && !helpOpen && (
          <TabOverview
            leaving={overviewShown.leaving}
            tabs={s.tabs}
            activeTabId={tab.id}
            onPick={(id) => { dispatch({ type: 'selectTab', id }); setOverviewOpen(false) }}
            onClose={closeOverview}
          />
        )}
      </div>
    </div>
  )
}
