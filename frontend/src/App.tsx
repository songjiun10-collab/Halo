import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Activity } from './components/Activity'
import { ControllerChip } from './components/ControllerChip'
import { HaloButton } from './components/HaloButton'
import { HaloChat } from './components/HaloChat'
import { HaloSheet } from './components/HaloSheet'
import { Back, Forward } from './components/Icons'
import { Notice } from './components/Notice'
import { ShortcutsHelp } from './components/ShortcutsHelp'
import { TabOverview } from './components/TabOverview'
import { TabStrip } from './components/TabStrip'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { usePresence } from './hooks/usePresence'
import { useShortcuts } from './hooks/useShortcuts'
import { useTrackpad } from './hooks/useTrackpad'
import { captureSnapshot, syncDirectSurface, syncNativeSurface } from './session/browser-surface'
import { AGENT, canNavigate, currentUrl, NEW_TAB_URL, pendingCriteria, SessionStore } from './session/session'
import { tabTitle } from './session/pages'
import type { SessionState, Tab, TimelineEvent } from './session/types'

const NOTICE_MS = 6000

/** Shown before any task is selected, when the harness has no browser tab to report yet. */
const HOME_TAB: Tab = { id: 'home', history: [NEW_TAB_URL], index: 0, canGoBack: false, canGoForward: false }

/** One sentence per change for the polite live region, including Halo's blocks. */
function announcement(s: SessionState, notice: TimelineEvent | null) {
  if (s.control === 'approval' && s.approval) return `Halo paused ${AGENT}: approve ${s.approval.action.toLowerCase()}?`
  if (notice) return `Halo ${notice.text.charAt(0).toLowerCase()}${notice.text.slice(1)}${notice.detail ? ` to ${notice.detail}` : ''}.`
  if (s.control === 'you') return s.finished && s.task ? `${AGENT} finished. You are browsing.` : 'You are browsing.'
  return `${AGENT} is browsing.`
}

export default function App() {
  const [store] = useState(() => new SessionStore(window.haloBrowser))
  const s = useSyncExternalStore(store.subscribe, store.getState)
  useEffect(() => store.connect(), [store])

  const [activityOpen, setActivityOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  /** ⌘/Ctrl + . keeps Halo's controls unfolded even when nothing needs you. */
  const [pinned, setPinned] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const omniRef = useRef<HTMLInputElement>(null)
  const pageRef = useRef<HTMLElement>(null)
  const [toast, setToast] = useState<string | null>(null)
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(id)
  }, [toast])
  const [seen, setSeen] = useState(0)
  const [dismissedNotice, setDismissedNotice] = useState<number | null>(null)
  const [swipeHint, setSwipeHint] = useState<'back' | 'forward' | null>(null)
  useEffect(() => {
    if (!swipeHint) return
    const id = window.setTimeout(() => setSwipeHint(null), 500)
    return () => window.clearTimeout(id)
  }, [swipeHint])

  // Surface a real backend failure once, as a toast, then clear it so it doesn't repeat.
  useEffect(() => {
    if (s.error) { setToast(s.error); store.clearError() }
  }, [s.error, store])

  // A Halo block needs no answer: show it for NOTICE_MS (even as the agent keeps working), then it lives in Activity.
  const lastBlock = useMemo(() => [...s.timeline].reverse().find((e) => e.actor === 'halo') ?? null, [s.timeline])
  const notice: TimelineEvent | null = lastBlock && lastBlock.id !== dismissedNotice ? lastBlock : null
  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setDismissedNotice(notice.id), NOTICE_MS)
    return () => window.clearTimeout(id)
  }, [notice])

  const tab = s.tabs.find((t) => t.id === s.activeTabId) ?? s.tabs[0] ?? HOME_TAB
  const approval = s.approval

  const notableCount = s.timeline.filter((e) => e.notable).length
  // Reached only from Notice's "Details" link now that the halo ring opens Chat.
  const openActivity = useCallback(() => {
    setActivityOpen(true); setChatOpen(false); setOverviewOpen(false); setHelpOpen(false)
    setSeen(notableCount); if (lastBlock) setDismissedNotice(lastBlock.id)
  }, [notableCount, lastBlock])
  const closeActivity = useCallback(() => { setActivityOpen(false); setSeen(notableCount) }, [notableCount])
  const openChat = useCallback(() => {
    setChatOpen(true); setActivityOpen(false); setOverviewOpen(false); setHelpOpen(false)
    setSeen(notableCount); if (lastBlock) setDismissedNotice(lastBlock.id)
  }, [notableCount, lastBlock])
  const closeChat = useCallback(() => { setChatOpen(false); setSeen(notableCount) }, [notableCount])
  const toggleChat = useCallback(() => { if (chatOpen) closeChat(); else openChat() }, [chatOpen, closeChat, openChat])
  const closeOverview = useCallback(() => setOverviewOpen(false), [])
  const toggleOverview = useCallback(() => {
    setOverviewOpen((o) => {
      if (!o) { setActivityOpen(false); setChatOpen(false); setHelpOpen(false) }
      return !o
    })
  }, [])
  const toggleHelp = useCallback(() => {
    setHelpOpen((h) => {
      if (!h) { setActivityOpen(false); setChatOpen(false); setOverviewOpen(false) }
      return !h
    })
  }, [])

  const onShare = useCallback(async () => {
    const url = currentUrl(tab)
    try {
      if (navigator.share) await navigator.share({ title: tabTitle(tab), url })
      else { await navigator.clipboard.writeText(url); setToast('Link copied') }
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') setToast('Unable to share this page')
    }
  }, [tab])
  const onNewWindow = useCallback(() => { void store.newWindow() }, [store])
  const onSendMessage = useCallback((text: string) => { void store.sendMessage(text) }, [store])
  const onNewTask = useCallback(() => { store.newTask(); openChat() }, [store, openChat])

  // Native tab commands are owned by the direct browser API. Task-owned browser tabs remain
  // isolated and cannot be mutated through that API.
  const shortcutHandlers = useMemo(() => ({
    onNewTab: () => { void store.newBrowserTab() },
    onNewTask,
    onCloseTab: () => { if (tab.id !== 'home') void store.closeBrowserTab(tab.id) },
    onSelectTab: (id: string) => void store.selectBrowserTab(id),
    onBack: () => void store.navigate({ type: 'back' }),
    onForward: () => void store.navigate({ type: 'forward' }),
    onFocusOmni: () => omniRef.current?.focus(),
    onTogglePin: () => setPinned((p) => !p),
    onToggleChat: toggleChat,
    onToggleOverview: toggleOverview,
    onNewWindow,
    onShare,
    onToggleHelp: toggleHelp,
    onToggleSidebar: () => setSidebarOpen((open) => !open),
  }), [store, onNewTask, toggleChat, toggleOverview, onNewWindow, onShare, toggleHelp, tab.id])
  useShortcuts(s, approval, shortcutHandlers)

  const trackpadHandlers = useMemo(() => ({
    onBack: () => { void store.navigate({ type: 'back' }); setSwipeHint('back') },
    onForward: () => { void store.navigate({ type: 'forward' }); setSwipeHint('forward') },
    onToggleOverview: toggleOverview,
  }), [store, toggleOverview])
  useTrackpad(!approval, overviewOpen, trackpadHandlers)

  const unseen = Math.max(0, notableCount - seen)
  // Folded: nothing needs a person, so Halo shows nothing at all — just the browser.
  // It unfolds for a block, an approval, a handoff back, unseen events, or on hover / keyboard focus in the toolbar.
  const needsYou = s.control === 'approval' || (s.control === 'you' && !s.finished)
  const folded = !pinned && !activityOpen && !chatOpen && !notice && unseen === 0 && !needsYou

  const driven = s.control !== 'you' && (tab.claude === 'working' || tab.claude === 'waiting')
  // The home screen offers a way back into a task already running elsewhere, rather than
  // pretending a fresh one can start here. HomeScreen's `tabId` slot carries a task id here.
  const otherTask = s.tasks.find((t) => t.taskId !== s.activeTaskId)
  const activeTask = otherTask ? { text: otherTask.originalRequest, tabId: otherTask.taskId } : undefined
  const recentTasks = useMemo(
    () => s.tasks.filter((t) => t.taskId !== s.activeTaskId).map((t) => ({ taskId: t.taskId, label: t.originalRequest, meta: `${t.state}${t.pauseReason ? ` · ${t.pauseReason}` : ''}` })),
    [s.tasks, s.activeTaskId],
  )

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
  // At the moment of a decision, show only the decision: Activity/Chat close rather than stack behind the sheet.
  if (approval && activityOpen) { setActivityOpen(false); setSeen(notableCount) }
  if (approval && chatOpen) { setChatOpen(false); setSeen(notableCount) }

  // Overlays stay mounted briefly after they're dismissed so they can animate out.
  const sheet = usePresence(approval ?? null)
  const noticeShown = usePresence(notice && !activityOpen && !chatOpen && !approval ? notice : null)
  const activityShown = usePresence(activityOpen ? true : null)
  const chatShown = usePresence(chatOpen ? true : null)
  const toastShown = usePresence(toast)
  const overviewShown = usePresence(overviewOpen ? true : null)
  const helpShown = usePresence(helpOpen ? true : null)

  const nativeSurfaceVisible = ((!!s.activeTaskId && !!s.browser) || (!s.activeTaskId && s.directBrowser)) && !approval && !activityOpen && !chatOpen &&
    !overviewOpen && !helpOpen && !noticeShown.item && !toastShown.item
  // A native view draws above the DOM, so overlays hide it. A still of the page stays in the
  // slot meanwhile: taken while the page is still on screen, then the view is hidden.
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const surfaceShown = useRef(false)
  const visibleNow = useRef(nativeSurfaceVisible)
  visibleNow.current = nativeSurfaceVisible
  useEffect(() => setSnapshot(null), [s.activeTaskId])
  useLayoutEffect(() => {
    const api = window.haloBrowser
    if (!api) return
    let disposed = false
    let frame = 0
    const sync = (then?: () => void) => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        if (!disposed) {
          void Promise.all([
            syncNativeSurface(api, s.activeTaskId, pageRef.current, !!s.activeTaskId && nativeSurfaceVisible),
            syncDirectSurface(api, pageRef.current, !s.activeTaskId && nativeSurfaceVisible),
          ]).catch(() => {}).then(() => { if (!disposed) then?.() })
        }
      })
    }
    const observer = pageRef.current ? new ResizeObserver(() => sync()) : null
    if (pageRef.current) observer?.observe(pageRef.current)
    const onResize = () => sync()
    window.addEventListener('resize', onResize)
    if (nativeSurfaceVisible) {
      surfaceShown.current = true
      // Drop the still only once the live page is back on top of it.
      sync(() => setSnapshot(null))
    } else if (surfaceShown.current) {
      surfaceShown.current = false
      void captureSnapshot(api).then((url) => {
        if (!visibleNow.current) setSnapshot(url)
        sync()
      })
    } else {
      sync()
    }
    return () => {
      disposed = true
      if (frame) cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', onResize)
    }
  }, [s.activeTaskId, s.browser, s.directBrowser, nativeSurfaceVisible])
  // The next run of the effect above places or hides the view; only leaving the app hides it outright.
  useEffect(() => () => {
    const api = window.haloBrowser
    if (!api) return
    void syncNativeSurface(api, null, null, false).catch(() => {})
    void syncDirectSurface(api, null, false).catch(() => {})
  }, [])

  const tabsForDisplay = s.tabs.length ? s.tabs : [HOME_TAB]

  return (
    <div className="hx-app" data-active-task-id={s.activeTaskId ?? undefined}>
      <a className="hx-skip" href="#hx-page" inert={!!approval}>Skip to page</a>
      <h1 className="hx-sr">HALO</h1>
      <p className="hx-sr" role="status" aria-live="polite">{announcement(s, notice)}</p>
      <div className="hx-window">
        <header className="hx-chrome" inert={overviewOpen || !!approval}>
          <Toolbar
            folded={folded}
            tab={tab}
            locked={!canNavigate(s)}
            omniRef={omniRef}
            onBack={() => void store.navigate({ type: 'back' })}
            onForward={() => void store.navigate({ type: 'forward' })}
            onShare={onShare}
            onOverview={toggleOverview}
            onActivity={openActivity}
            onNavigate={(url) => void store.navigate({ type: 'navigate', url })}
            onNewWindow={onNewWindow}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((open) => !open)}
            controller={
              <ControllerChip
                control={s.control}
                finished={s.finished}
                recoveryReason={s.recoveryReason}
                onTakeOver={() => void store.control('takeOver')}
                onResume={() => void store.control('resume', s.recoveryReason === 'execution_uncertain')}
              />
            }
              halo={<HaloButton unseen={unseen} open={chatOpen} onToggle={toggleChat} />}
            />
          <TabStrip
            tabs={tabsForDisplay}
            activeTabId={tab.id}
            canClose={(candidate) => !s.activeTaskId && tabsForDisplay.length > 1 && candidate.id !== 'home'}
            onSelect={(id) => void store.selectBrowserTab(id)}
            onClose={(id) => void store.closeBrowserTab(id)}
            canCreate={!s.activeTaskId}
            onNew={() => { void store.newBrowserTab() }}
          />
        </header>
        <div className="hx-window-row hx-workspace">
          <WorkspaceSidebar
            tasks={s.tasks}
            activeTaskId={s.activeTaskId}
            open={sidebarOpen}
            inert={overviewOpen || !!approval}
            onNewTask={onNewTask}
            onSelectTask={(taskId) => void store.selectTask(taskId)}
          />
          <div className="hx-content-col">
          <div className="hx-body" inert={overviewOpen}>
            <div className="hx-page" inert={!!approval}>
              {(s.activeTaskId && s.browser) || (!s.activeTaskId && s.directBrowser) ? (
                <main
                  id="hx-page"
                  ref={pageRef}
                  className="hx-native-page"
                  role="tabpanel"
                  aria-labelledby={`tab-${tab.id}`}
                  aria-label="Page rendered in the isolated browser surface"
                  tabIndex={-1}
                >
                  {snapshot && !nativeSurfaceVisible && <img className="hx-snapshot" src={snapshot} alt="" aria-hidden="true" draggable={false} />}
                </main>
              ) : (
                <Viewport
                  tab={tab}
                  driven={driven && !folded}
                  activeTask={activeTask}
                  onSelectTab={(id) => void store.selectTask(id)}
                  onStartTask={onSendMessage}
                />
              )}
              <div className="hx-edge" data-on={(driven && !folded) || undefined} aria-hidden="true" />
              {swipeHint && (
                <span className={`hx-swipe hx-swipe--${swipeHint}`} aria-hidden="true">
                  {swipeHint === 'back' ? <Back /> : <Forward />}
                </span>
              )}
            </div>
            {/* One Halo surface at a time: a surface a newer one supersedes cuts instantly rather
              than cross-fading underneath it, so the glass never stacks two deep. */}
            <div className="hx-overlays">
              {sheet.item && (
                <HaloSheet
                  approval={sheet.item}
                  leaving={sheet.leaving}
                  onApprove={() => void store.decideApproval('approve', sheet.item!)}
                  onDeny={() => void store.decideApproval('deny', sheet.item!)}
                  onTakeOver={() => void store.control('takeOver')}
                />
              )}
              {noticeShown.item && !activityOpen && !chatOpen && !approval && <Notice event={noticeShown.item} leaving={noticeShown.leaving} blocked={!!approval} onOpen={openActivity} />}
              {activityShown.item && !approval && !chatOpen && !overviewOpen && !helpOpen && <Activity session={s} leaving={activityShown.leaving} onClose={closeActivity} />}
              {chatShown.item && !approval && !activityOpen && !overviewOpen && !helpOpen && (
                <HaloChat
                  taskLabel={s.task || 'New task'}
                  messages={s.messages}
                  recentTasks={recentTasks}
                  pendingCriteria={pendingCriteria(s)}
                  isTaskActive={!!s.activeTaskId}
                  leaving={chatShown.leaving}
                  onClose={closeChat}
                  onSend={onSendMessage}
                  onSelectTask={(taskId) => void store.selectTask(taskId)}
                  onNewTask={() => { store.newTask(); closeChat() }}
                  onConfirmCriterion={(criterion, outcome) => void store.confirmCriterion(criterion, outcome)}
                />
              )}
              {helpShown.item && !approval && !activityOpen && !chatOpen && !overviewOpen && <ShortcutsHelp leaving={helpShown.leaving} onClose={() => setHelpOpen(false)} />}
              {toastShown.item && <p className="hx-toast" role="status" data-leaving={toastShown.leaving || undefined}>{toastShown.item}</p>}
            </div>
          </div>
          </div>
        </div>
        {overviewShown.item && !approval && !activityOpen && !chatOpen && !helpOpen && (
          <TabOverview
            leaving={overviewShown.leaving}
            tabs={tabsForDisplay}
            activeTabId={tab.id}
            onPick={(id) => { void store.selectBrowserTab(id); closeOverview() }}
            onClose={closeOverview}
          />
        )}
      </div>
    </div>
  )
}
