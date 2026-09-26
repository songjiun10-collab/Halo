import { getDomain } from 'tldts'
import type { Actor, Approval, Control, PlannedStep, SessionState, Tab, TabActivity, TimelineEvent } from './types'

/** The agent's name: shown in details, never as the chrome's visual language. */
export const AGENT = 'Claude'
/** What the chrome calls whoever is driving when it isn't you. Multi-agent safe. */
export const AGENT_ROLE = 'Agent'

export const controlLabel: Record<Control, string> = {
  claude: `${AGENT_ROLE} is browsing`,
  approval: `${AGENT_ROLE} is waiting for you`,
  you: 'You are browsing',
}

export type Action =
  | { type: 'tick' }
  | { type: 'approve' }
  | { type: 'deny' }
  | { type: 'takeControl' }
  | { type: 'resume' }
  | { type: 'selectTab'; id: string }
  | { type: 'closeTab'; id: string }
  | { type: 'newTab' }
  | { type: 'back' }
  | { type: 'forward' }

export const NEW_TAB_URL = 'halo://newtab'

let tabSeq = 0
const makeTab = (url: string, claude?: TabActivity): Tab => ({ id: `tab-${++tabSeq}`, history: [url], index: 0, claude })

export const currentUrl = (tab: Tab) => tab.history[tab.index]

/** Claude holds a tab while it is working or waiting in it; you can't navigate or close it then. */
export const claudeHolds = (s: SessionState, tab: Tab) => s.control !== 'you' && (tab.claude === 'working' || tab.claude === 'waiting')

/**
 * A tab the unfinished task still refers to can't be closed, even while you have control:
 * closing it would leave the remaining steps pointing at a tab that no longer exists.
 */
export const canCloseTab = (s: SessionState, tab: Tab) =>
  !claudeHolds(s, tab) && (s.finished || !Object.values(s.tabKeys).includes(tab.id))

function parse(url: string): URL | null {
  try { return new URL(url) } catch { return null }
}

/** Hostname, or the input itself when it isn't a URL. */
export const host = (url: string) => parse(url)?.hostname || url

/**
 * Splits a URL around its registrable domain (public-suffix aware: shop.example.co.uk
 * → example.co.uk) so the address bar can emphasise the real site identity.
 * Hosts without one (localhost, IP addresses) are emphasised whole.
 */
export function splitUrl(url: string): { before: string; domain: string; after: string } {
  const u = parse(url)
  if (!u || !/^https?:$/.test(u.protocol)) return { before: '', domain: url, after: '' }
  const hostname = u.host
  const domain = getDomain(u.hostname) ?? hostname
  const at = hostname.lastIndexOf(domain)
  const start = u.protocol + '//'
  const sub = at > 0 ? hostname.slice(0, at) : ''
  const rest = at >= 0 ? hostname.slice(at + domain.length) : ''
  return { before: start + sub, domain: at >= 0 ? domain + rest : hostname, after: url.slice(url.indexOf(hostname) + hostname.length) }
}

/**
 * What the approval sheet shows for a review step. Payment steps carry their own
 * facts; any other review still gets a usable prompt built from the step.
 */
export function approvalFor(step: PlannedStep): Approval {
  if (step.approval) return step.approval
  const action = step.text.replace(/^Wants to /, '')
  return {
    action: action.charAt(0).toUpperCase() + action.slice(1),
    doneText: step.text,
    amount: '',
    paymentMethod: '',
    destination: host(step.target),
    request: step.target,
  }
}

function navigate(tab: Tab, url: string): Tab {
  const history = [...tab.history.slice(0, tab.index + 1), url]
  return { ...tab, history, index: history.length - 1 }
}

let eventSeq = 0
function log(s: SessionState, actor: Actor, text: string, extra: Partial<TimelineEvent> = {}): SessionState {
  return { ...s, timeline: [...s.timeline, { id: ++eventSeq, actor, text, ...extra }] }
}

/** Marks Claude's activity per tab: `id` gets `activity`; any other tab Claude was working in is done. */
function setActivity(s: SessionState, id: string, activity: TabActivity): SessionState {
  return {
    ...s,
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, claude: activity } : t.claude && t.claude !== 'done' ? { ...t, claude: 'done' } : t)),
  }
}

/** Once an ask is answered or set aside, its line stops reading "Needs approval". */
function settleAsk(s: SessionState): SessionState {
  const timeline = s.timeline.map((e) =>
    e.outcome === 'approval' ? { ...e, outcome: undefined, text: e.text.replace(/^Wants to/, 'Asked to') } : e,
  )
  return { ...s, timeline }
}

const mapTabs = (s: SessionState, fn: (t: Tab) => Tab): SessionState => ({ ...s, tabs: s.tabs.map(fn) })

/** Runs one of Claude's steps that the gateway let through or stopped. */
function runStep(s: SessionState, step: PlannedStep): SessionState {
  let next = s
  // Nothing runs unless the gateway allowed it: a blocked step opens no tab and navigates nowhere.
  if (step.verdict === 'allow') {
    if (step.opensTab && !next.tabKeys[step.tab]) {
      // Claude opens its own tab in the background; your view stays where it is.
      const tab = makeTab(step.navigatesTo ?? NEW_TAB_URL)
      next = { ...next, tabs: [...next.tabs, tab], tabKeys: { ...next.tabKeys, [step.tab]: tab.id } }
    } else if (step.navigatesTo) {
      const id = next.tabKeys[step.tab]
      next = mapTabs(next, (t) => (t.id === id ? navigate(t, step.navigatesTo!) : t))
    }
  }
  const tabId = next.tabKeys[step.tab]
  if (tabId) next = setActivity(next, tabId, 'working')
  if (step.verdict === 'allow') return log(next, 'claude', step.text, { detail: step.target, outcome: 'done', policy: 'allow' })
  return log(next, 'halo', step.haloText ?? `Blocked: ${step.text}`, { detail: step.target, outcome: 'blocked', policy: step.verdict, notable: true })
}

function finish(s: SessionState): SessionState {
  return { ...mapTabs(s, (t) => (t.claude ? { ...t, claude: 'done' } : t)), control: 'you', finished: true }
}

export function reducer(s: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'tick': {
      if (s.control !== 'claude') return s
      const [step, ...plan] = s.plan
      if (!step) return finish(log(s, 'claude', 'Finished the task', { notable: true }))
      if (step.verdict === 'review') {
        const waiting = setActivity({ ...s, plan, pending: step, control: 'approval' }, s.tabKeys[step.tab], 'waiting')
        return log(waiting, 'claude', step.text, { detail: approvalFor(step).destination, outcome: 'approval', policy: 'review', notable: true })
      }
      return { ...runStep(s, step), plan }
    }
    case 'approve': {
      if (s.control !== 'approval' || !s.pending) return s
      const step = s.pending
      const approved = log({ ...settleAsk(s), pending: undefined, control: 'claude' }, 'you', `Approved ${step.approval?.amount || approvalFor(step).action.toLowerCase()}`, { outcome: 'approved', notable: true })
      return runStep(approved, { ...step, verdict: 'allow', text: step.approval?.doneText ?? step.text })
    }
    case 'deny': {
      if (s.control !== 'approval' || !s.pending) return s
      const denied = log({ ...settleAsk(s), pending: undefined, plan: [] }, 'you', `Denied: ${approvalFor(s.pending).action.toLowerCase()}`, { outcome: 'denied', notable: true })
      return finish(log(denied, 'claude', 'Stopped after you denied the request', { notable: true }))
    }
    case 'takeControl': {
      if (s.control === 'you') return s
      // A pending approval goes back into the plan; Claude asks again when you hand control back.
      const plan = s.pending ? [s.pending, ...s.plan] : s.plan
      const paused = mapTabs({ ...settleAsk(s), plan, pending: undefined, control: 'you' }, (t) => (t.claude === 'working' || t.claude === 'waiting' ? { ...t, claude: 'paused' } : t))
      return log(paused, 'you', 'Took over', { notable: true })
    }
    case 'resume': {
      if (s.control !== 'you' || s.finished) return s
      const resumed = mapTabs({ ...s, control: 'claude' }, (t) => (t.claude === 'paused' ? { ...t, claude: 'working' } : t))
      return log(resumed, 'you', `Handed back to ${AGENT}`, { notable: true })
    }
    case 'selectTab':
      return { ...s, activeTabId: action.id }
    case 'closeTab': {
      const i = s.tabs.findIndex((t) => t.id === action.id)
      if (i < 0 || !canCloseTab(s, s.tabs[i])) return s
      let tabs = s.tabs.filter((t) => t.id !== action.id)
      if (tabs.length === 0) tabs = [makeTab(NEW_TAB_URL)]
      const activeTabId = s.activeTabId === action.id ? tabs[Math.max(0, Math.min(i - 1, tabs.length - 1))].id : s.activeTabId
      return { ...s, tabs, activeTabId }
    }
    case 'newTab': {
      const tab = makeTab(NEW_TAB_URL)
      return log({ ...s, tabs: [...s.tabs, tab], activeTabId: tab.id }, 'you', 'Opened a new tab')
    }
    case 'back':
    case 'forward': {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      if (!tab || claudeHolds(s, tab)) return s
      const index = tab.index + (action.type === 'back' ? -1 : 1)
      if (index < 0 || index >= tab.history.length) return s
      const moved = mapTabs(s, (t) => (t.id === tab.id ? { ...t, index } : t))
      return log(moved, 'you', action.type === 'back' ? 'Went back' : 'Went forward', { detail: host(tab.history[index]) })
    }
  }
}

/**
 * DEMO session: a scripted run so the UI can be exercised without a live
 * gateway. Replace with events from HALO's gateway.
 */
export function demoSession(): SessionState {
  const store = makeTab('https://www.example.com/cart', 'working')
  const orders = makeTab('https://www.example.com/orders')
  return {
    task: 'Buy the headphones in my cart',
    control: 'claude',
    finished: false,
    tabs: [store, orders],
    tabKeys: { store: store.id },
    activeTabId: store.id,
    timeline: [],
    plan: [
      { tab: 'store', text: 'Read your cart', target: 'section#cart', verdict: 'allow' },
      { tab: 'reviews', text: 'Checked reviews for the headphones', target: 'reviews.example.org', verdict: 'allow', opensTab: 'Reviews', navigatesTo: 'https://reviews.example.org/headphones' },
      { tab: 'store', text: 'Went to checkout', target: 'checkout.example.com', verdict: 'allow', navigatesTo: 'https://checkout.example.com/pay' },
      { tab: 'store', text: 'Filled shipping address', target: 'form#shipping', verdict: 'allow' },
      { tab: 'store', text: 'Send address to a tracking widget', haloText: 'Blocked a tracking request', target: 'track.adnet-example.net', verdict: 'quarantine' },
      {
        tab: 'store',
        text: 'Wants to place order',
        target: 'button[type=submit]',
        verdict: 'review',
        navigatesTo: 'https://checkout.example.com/done',
        approval: {
          action: 'Place order',
          doneText: 'Placed the order',
          amount: '$84.20',
          paymentMethod: 'Visa ending 4471',
          destination: 'checkout.example.com',
          request: 'POST https://checkout.example.com/pay',
        },
      },
      { tab: 'store', text: 'Read the order confirmation', target: 'main#confirmation', verdict: 'allow' },
    ],
  }
}
