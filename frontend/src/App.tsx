import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Activity } from './components/Activity'
import { ControllerChip } from './components/ControllerChip'
import { FindBar } from './components/FindBar'
import { HaloButton } from './components/HaloButton'
import { HaloChat } from './components/HaloChat'
import { HaloSheet } from './components/HaloSheet'
import { Notice } from './components/Notice'
import { SettingsPanel } from './components/SettingsPanel'
import { ShortcutsHelp } from './components/ShortcutsHelp'
import { TabOverview } from './components/TabOverview'
import { Toolbar } from './components/Toolbar'
import { Viewport } from './components/Viewport'
import { WorkspaceSidebar } from './components/WorkspaceSidebar'
import { SidebarAgents } from './agent/SidebarAgents'
import { openAgentView, type AgentNavView } from './agent/agent-nav'
import { usePresence } from './hooks/usePresence'
import { useShortcuts } from './hooks/useShortcuts'
import { useTrackpad } from './hooks/useTrackpad'
import type { BrowserSnapshot, TaskInput } from './session/api'
import { RemotePageFrame } from './components/RemotePageFrame'
import { DirectBrowserSurface } from './components/DirectBrowserSurface'
import { captureSnapshot, shouldCaptureRemoteTaskFrame, syncDirectSurface, syncNativeSurface } from './session/browser-surface'
import { AGENT, canNavigate, currentUrl, NEW_TAB_URL, pendingCriteria, SessionStore } from './session/session'
import { tabTitle } from './session/pages'
import type { IntentLockInput } from './session/api'
import { LeaseChip } from './components/LeaseChip'
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
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia?.('(max-width: 880px)').matches)
  // A narrow window folds the sidebar to its icon rail; widening it brings the full sidebar back.
  useEffect(() => {
    const query = window.matchMedia?.('(max-width: 880px)')
    if (!query) return
    const sync = () => setSidebarOpen(!query.matches)
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  const [chatOpen, setChatOpen] = useState(false)
  /** ⌘/Ctrl + . keeps Halo's controls unfolded even when nothing needs you. */
  const [pinned, setPinned] = useState(false)
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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
    setActivityOpen(true); setChatOpen(false); setOverviewOpen(false); setHelpOpen(false); setSettingsOpen(false)
    setSeen(notableCount); if (lastBlock) setDismissedNotice(lastBlock.id)
  }, [notableCount, lastBlock])
  const closeActivity = useCallback(() => { setActivityOpen(false); setSeen(notableCount) }, [notableCount])
  const toggleActivity = useCallback(() => { if (activityOpen) closeActivity(); else openActivity() }, [activityOpen, closeActivity, openActivity])
  const openChat = useCallback(() => {
    setChatOpen(true); setActivityOpen(false); setOverviewOpen(false); setHelpOpen(false); setSettingsOpen(false)
    setSeen(notableCount); if (lastBlock) setDismissedNotice(lastBlock.id)
  }, [notableCount, lastBlock])
  const closeChat = useCallback(() => { setChatOpen(false); setSeen(notableCount) }, [notableCount])
  const toggleChat = useCallback(() => { if (chatOpen) closeChat(); else openChat() }, [chatOpen, closeChat, openChat])
  const closeOverview = useCallback(() => setOverviewOpen(false), [])
  const toggleOverview = useCallback(() => {
    setOverviewOpen((o) => {
      if (!o) { setActivityOpen(false); setChatOpen(false); setHelpOpen(false); setSettingsOpen(false) }
      return !o
    })
  }, [])
  const toggleHelp = useCallback(() => {
    setHelpOpen((h) => {
      if (!h) { setActivityOpen(false); setChatOpen(false); setOverviewOpen(false); setSettingsOpen(false) }
      return !h
    })
  }, [])
  const toggleSettings = useCallback(() => {
    setSettingsOpen((o) => {
      if (!o) { setActivityOpen(false); setChatOpen(false); setOverviewOpen(false); setHelpOpen(false) }
      return !o
    })
  }, [])

  const onShare = useCallback(async () => {
    const url = currentUrl(tab)
    if (url.startsWith('halo://')) { setToast('Open a web page to share it'); return }
    // The host clipboard first: it needs neither a user gesture nor a permission.
    if (await store.copyText(url)) { setToast('Link copied'); return }
    // Otherwise copy inside the click itself; awaiting anything first could spend the user gesture.
    const field = document.createElement('textarea')
    field.value = url
    field.setAttribute('readonly', '')
    field.style.cssText = 'position:fixed;opacity:0;pointer-events:none'
    document.body.appendChild(field)
    field.select()
    let copied = false
    try { copied = document.execCommand('copy') } catch { copied = false } finally { field.remove() }
    if (!copied) {
      try { await navigator.clipboard.writeText(url); copied = true } catch { copied = false }
    }
    setToast(copied ? 'Link copied' : 'Unable to share this page')
  }, [tab, store])
  // Mod+/Mod-/Mod+0. The task surface is read from the store at call time so
  // the handler never captures a stale active task.
  const zoomPage = useCallback((request: { direction?: 'in' | 'out' | 'reset'; level?: number }) => {
    const api = window.haloBrowser
    if (typeof api?.zoom !== 'function') return
    const taskId = store.getState().activeTaskId ?? null
    void api.zoom(taskId, request).then((result) => {
      if (result?.ok && typeof result.level === 'number') setToast(`Zoom ${Math.round(result.level * 100)}%`)
      else if (result && !result.ok && result.errorCode !== 'surface_unavailable') setToast('Zoom is unavailable here')
    }).catch(() => {})
  }, [store])
  // Mod+C. The task surface is read from the store at call time so the handler
  // never captures a stale active task.
  const copyPageSelection = useCallback(() => {
    const api = window.haloBrowser
    if (typeof api?.copySelection !== 'function') return
    const taskId = store.getState().activeTaskId ?? null
    void api.copySelection(taskId).then((result) => {
      if (!result?.ok) {
        if (result?.errorCode !== 'surface_unavailable') setToast('Could not copy')
        return
      }
      setToast(result.chars > 0 ? 'Copied' : 'Nothing selected')
    }).catch(() => {})
  }, [store])
  const onNewWindow = useCallback(() => { void store.newWindow() }, [store])
  const leases = s.snapshot?.leases ?? []
  const [leaseNow, setLeaseNow] = useState(() => Date.now())
  useEffect(() => {
    if (!leases.length) return
    setLeaseNow(Date.now())
    const timer = window.setInterval(() => setLeaseNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [leases.length])
  const onSendMessage = useCallback((text: string, lock?: IntentLockInput) => { void store.sendMessage(text, lock) }, [store])
  const onNewTask = useCallback(() => { store.newTask(); openChat() }, [store, openChat])
  // Agent and team rows only open the Agent home: leave the current task or page
  // for the home screen without starting, resuming or stopping anything.
  const openAgents = useCallback((view: AgentNavView) => {
    setSettingsOpen(false)
    openAgentView(view)
    const current = store.getState()
    if (current.activeTaskId || current.directBrowser) store.newTask()
  }, [store])

  // Native tab commands are owned by the direct browser API. Task-owned browser tabs remain
  // isolated and cannot be mutated through that API.
  const [findOpen, setFindOpen] = useState(false)
  // A search belongs to the page it was opened on; switching tab or task closes it.
  useEffect(() => { setFindOpen(false) }, [s.activeTaskId, s.activeTabId])
  const shortcutHandlers = useMemo(() => ({
    onNewTab: () => { void store.newBrowserTab() },
    onNewTask,
    onCloseTab: () => { if (tab.id !== 'home') void store.closeBrowserTab(tab.id) },
    onSelectTab: (id: string) => void store.selectBrowserTab(id),
    onBack: () => void store.navigate({ type: 'back' }),
    onForward: () => void store.navigate({ type: 'forward' }),
    onFocusOmni: () => omniRef.current?.focus(),
    onFind: () => setFindOpen(true),
    onZoomIn: () => zoomPage({ direction: 'in' }),
    onZoomOut: () => zoomPage({ direction: 'out' }),
    onZoomReset: () => zoomPage({ direction: 'reset' }),
    onTogglePin: () => setPinned((p) => !p),
    onToggleChat: toggleChat,
    onToggleOverview: toggleOverview,
    onNewWindow,
    onShare,
    onToggleHelp: toggleHelp,
    onToggleSidebar: () => setSidebarOpen((open) => !open),
    onToggleSettings: toggleSettings,
  }), [store, onNewTask, zoomPage, toggleChat, toggleOverview, onNewWindow, onShare, toggleHelp, toggleSettings, tab.id])
  useShortcuts(s, approval, shortcutHandlers)

  // Safari-style swipe: the page you leave slides off in the swipe's direction. The native view
  // can't be animated, so it is hidden for the slide while its still moves in its place.
  const [swipeDir, setSwipeDir] = useState<'back' | 'forward' | null>(null)
  useEffect(() => {
    if (!swipeDir) return
    const id = window.setTimeout(() => setSwipeDir(null), 340)
    return () => window.clearTimeout(id)
  }, [swipeDir])
  const trackpadHandlers = useMemo(() => ({
    onBack: () => { setSwipeDir('back'); void store.navigate({ type: 'back' }) },
    onForward: () => { setSwipeDir('forward'); void store.navigate({ type: 'forward' }) },
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
  if (approval && settingsOpen) setSettingsOpen(false)
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
  const settingsShown = usePresence(settingsOpen ? true : null)

  // The agent works in a hidden page. While the task is live (including while it waits on you,
  // is paused or awaits verification) its page is mirrored here, read-only: pushed frames when the
  // engine can stream, otherwise polled stills. The last frame stays until the task ends.
  const [agentFrame, setAgentFrame] = useState<string | null>(null)
  const taskState = s.snapshot?.state
  const agentWorking = !!s.activeTaskId && (taskState === 'running' || taskState === 'awaiting_approval' || taskState === 'awaiting_verification' || taskState === 'paused' || (!taskState && s.control === 'claude'))
  useEffect(() => {
    const api = window.haloBrowser
    const taskId = s.activeTaskId
    if (!agentWorking || !taskId || typeof api?.captureAgentFrame !== 'function') { setAgentFrame(null); return }
    let stopped = false
    let id: number | undefined
    let unsubscribe: (() => void) | undefined
    let streaming = false
    const tick = async () => {
      const frame = await api.captureAgentFrame!(taskId).catch(() => null)
      // A still that comes back empty (parked surface) never erases the frame already on screen.
      if (!stopped && (frame || !streaming)) setAgentFrame((current) => frame ?? current)
      if (!stopped && !streaming) id = window.setTimeout(() => void tick(), 250)
    }
    if (typeof api.startAgentStream === 'function' && typeof api.onAgentFrame === 'function') {
      unsubscribe = api.onAgentFrame((payload) => {
        if (!stopped && payload?.taskId === taskId && typeof payload.frame === 'string' && payload.frame.startsWith('data:image/jpeg;base64,')) setAgentFrame(payload.frame)
      })
      streaming = true
      void tick()
      void api.startAgentStream(taskId).then((started) => {
        if (stopped || started) { if (!started) streaming = false; return }
        streaming = false
        void tick()
      }).catch(() => { if (!stopped) { streaming = false; void tick() } })
    } else void tick()
    return () => {
      stopped = true
      window.clearTimeout(id)
      unsubscribe?.()
      if (typeof api.startAgentStream === 'function') void api.stopAgentStream?.().catch(() => {})
      setAgentFrame(null)
    }
  }, [agentWorking, s.activeTaskId])

  // When you take over from a UI attached to the background service, the task's page lives in
  // that other process: it arrives as stills here and your input goes back to it.
  const [userFrame, setUserFrame] = useState<string | null>(null)
  const userDriving = s.control === 'you' && !!s.activeTaskId
  useEffect(() => {
    const api = window.haloBrowser
    const taskId = s.activeTaskId
    // A local Chromium page is already painted natively above this renderer.
    // Capturing it every 120ms wastes CDP/GPU work and competes with page load,
    // input and navigation for the same browser connection. Only an attached
    // UI needs pixel mirroring from the separate background process.
    if (!shouldCaptureRemoteTaskFrame(api, userDriving, taskId)) { setUserFrame(null); return }
    const remoteApi = api!
    const remoteTaskId = taskId!
    let stopped = false
    const tick = async () => {
      const frame = await remoteApi.captureTaskFrame!(remoteTaskId).catch(() => null)
      if (!stopped) setUserFrame(frame)
      if (!stopped) id = window.setTimeout(() => void tick(), 200)
    }
    let id: number | undefined
    void tick()
    return () => { stopped = true; window.clearTimeout(id); setUserFrame(null) }
  }, [userDriving, s.activeTaskId])
  const sendInput = (input: TaskInput) => {
    const api = window.haloBrowser
    if (s.activeTaskId && typeof api?.sendTaskInput === 'function') void api.sendTaskInput(s.activeTaskId, input).catch(() => {})
  }
  const chromium = window.haloBrowser?.runtime === 'chromium'
  const directDriving = chromium && s.directBrowser && !s.activeTaskId

  const nativeSurfaceVisible = ((!!s.activeTaskId && !!s.browser) || (!s.activeTaskId && s.directBrowser)) && !approval && !activityOpen && !chatOpen &&
    !overviewOpen && !helpOpen && !settingsOpen && !noticeShown.item && !toastShown.item && !swipeDir && (chromium || (!agentFrame && !userFrame))
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
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true"><filter id="hx-refract" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.018" numOctaves="2" seed="7" result="n" /><feGaussianBlur in="n" stdDeviation="3" result="nb" /><feDisplacementMap in="SourceGraphic" in2="nb" scale="38" xChannelSelector="R" yChannelSelector="G" /></filter></svg>
      <a className="hx-skip" href="#hx-page" inert={!!approval}>Skip to page</a>
      <h1 className="hx-sr">HALO</h1>
      <p className="hx-sr" role="status" aria-live="polite">{announcement(s, notice)}</p>
      <div className="hx-window" data-frame="mac">
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
            onActivity={toggleActivity}
            onNavigate={(url) => void store.navigate({ type: 'navigate', url })}
            onAsk={onSendMessage}
            onSettings={toggleSettings}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((open) => !open)}
            controller={
              <>
                <ControllerChip
                  control={s.control}
                  finished={s.finished}
                  recoveryReason={s.recoveryReason}
                  onTakeOver={() => void store.control('takeOver')}
                  onResume={() => void store.control('resume', s.recoveryReason === 'execution_uncertain')}
                  awaitingReview={s.snapshot?.state === 'awaiting_verification' && pendingCriteria(s).length > 0}
                  onReview={openChat}
                />
                <LeaseChip leases={leases} now={leaseNow} agent={AGENT} onRevoke={(id) => void store.revokeLease(id)} />
              </>
            }
              halo={<HaloButton unseen={unseen} open={chatOpen} onToggle={toggleChat} />}
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
            tabs={tabsForDisplay.map((t) => ({ id: t.id, title: tabTitle(t), url: currentUrl(t) }))}
            activeTabId={tab.id}
            onSelectTab={(id) => void store.selectBrowserTab(id)}
            onCloseTab={!s.activeTaskId && tabsForDisplay.length > 1 ? (id) => { if (id !== 'home') void store.closeBrowserTab(id) } : undefined}
            onOpenUrl={(url) => void store.navigate({ type: 'navigate', url })}
            onNewTab={!s.activeTaskId ? () => { void store.newBrowserTab() } : undefined}
            agents={<SidebarAgents onOpen={(owner) => openAgents({ n: 'detail', owner })} onSeeAll={() => openAgents({ n: 'hub' })} onNew={() => openAgents({ n: 'hub' })} />}
          />
          <div className="hx-content-col">
          <div className="hx-body" inert={overviewOpen}>
            <div className="hx-page" inert={!!approval}>
              {(s.activeTaskId && (s.browser || agentFrame)) || (!s.activeTaskId && s.directBrowser) ? (
                <main
                  id="hx-page"
                  ref={pageRef}
                  className="hx-native-page"
                  role="tabpanel"
                  aria-labelledby={`tab-${tab.id}`}
                  aria-label="Page rendered in the isolated browser surface"
                  tabIndex={-1}
                >
                  {agentFrame && !userFrame && <img className="hx-snapshot" data-live="agent" src={agentFrame} alt="" aria-hidden="true" draggable={false} />}
                  {userFrame && <RemotePageFrame frame={userFrame} onInput={sendInput} onCopy={copyPageSelection} />}
                  {directDriving && <DirectBrowserSurface tabId={s.activeTabId} onCopy={copyPageSelection} />}
                  {findOpen && <FindBar targetTaskId={s.activeTaskId ?? null} onClose={() => setFindOpen(false)} />}
                  {snapshot && !agentFrame && !userFrame && !nativeSurfaceVisible && <img className="hx-snapshot" data-swipe={swipeDir || undefined} src={snapshot} alt="" aria-hidden="true" draggable={false} />}
                </main>
              ) : (
                <Viewport
                  tab={tab}
                  driven={driven && !folded}
                  activeTask={activeTask}
                  onSelectTab={(id) => void store.selectTask(id)}
                  onStartTask={onSendMessage}
                  onNavigate={(url) => void store.navigate({ type: 'navigate', url })}
                />
              )}
              <div className="hx-edge" data-on={(driven && !folded) || undefined} aria-hidden="true" />
            </div>
            {chatShown.item && !approval && !activityOpen && !overviewOpen && !helpOpen && (
                <HaloChat
                  taskLabel={s.task || 'New task'}
                  tabContext={chatTabContext(s.browser)}
                  messages={s.messages}
                  timeline={s.timeline}
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
                  onLend={(terms) => void store.lend(sheet.item!, terms)}
                />
              )}
              {noticeShown.item && !activityOpen && !chatOpen && !approval && <Notice event={noticeShown.item} leaving={noticeShown.leaving} blocked={!!approval} onOpen={openActivity} />}
              {activityShown.item && !approval && !chatOpen && !overviewOpen && !helpOpen && <Activity session={s} leaving={activityShown.leaving} onClose={closeActivity} />}
              {helpShown.item && !approval && !activityOpen && !chatOpen && !overviewOpen && <ShortcutsHelp leaving={helpShown.leaving} onClose={() => setHelpOpen(false)} />}
              {toastShown.item && <p className="hx-toast" role="status" data-leaving={toastShown.leaving || undefined}>{toastShown.item}</p>}
            </div>
            {settingsShown.item && !approval && !activityOpen && !chatOpen && !overviewOpen && !helpOpen && <SettingsPanel leaving={settingsShown.leaving} onClose={() => setSettingsOpen(false)} />}
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

/** The agent's active page as a chat context chip: its title and host, never the full URL. */
function chatTabContext(browser: BrowserSnapshot | null): { title: string; host: string } | null {
  const page = browser?.tabs.find((t) => t.id === browser.activeTabId)
  if (!page) return null
  let host = ''
  try { host = new URL(page.url).host } catch { /* about:blank and the like have no host */ }
  return host || page.title ? { title: page.title, host } : null
}
