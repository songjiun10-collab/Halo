import type { AgentState, PlannedStep, SessionState, Step, Tab } from './types'

export const agentLabel: Record<AgentState, string> = {
  idle: 'Agent idle',
  acting: 'Agent is working',
  waiting: 'Waiting for you',
  stopped: 'Agent paused',
}

export type Action =
  | { type: 'tick'; now: number }
  | { type: 'approve'; now: number }
  | { type: 'deny'; now: number }
  | { type: 'pause'; now: number }
  | { type: 'resume'; now: number }
  | { type: 'selectTab'; id: string }
  | { type: 'closeTab'; id: string }
  | { type: 'newTab' }
  | { type: 'back' }
  | { type: 'forward' }

export const NEW_TAB_URL = 'halo://newtab'

let tabSeq = 0
const makeTab = (url: string, agent = false): Tab => ({ id: `tab-${++tabSeq}`, history: [url], index: 0, agent })

export const currentUrl = (tab: Tab) => tab.history[tab.index]

/** The agent drives its tab while acting or waiting; the person can't navigate it then. */
export const agentHolds = (s: SessionState, tab: Tab) => tab.agent && (s.agent === 'acting' || s.agent === 'waiting')

/** Splits a URL so the registrable domain (last two host labels) can be emphasised. */
export function splitUrl(url: string): { before: string; domain: string; after: string } {
  const m = /^(https?:\/\/)([^/]+)(.*)$/.exec(url)
  if (!m) return { before: '', domain: url, after: '' }
  const labels = m[2].split('.')
  const sub = labels.slice(0, -2).join('.')
  return { before: m[1] + (sub ? sub + '.' : ''), domain: labels.slice(-2).join('.'), after: m[3] }
}

function navigate(tab: Tab, url: string): Tab {
  const history = [...tab.history.slice(0, tab.index + 1), url]
  return { ...tab, history, index: history.length - 1 }
}

const releaseAgentTab = (s: SessionState): SessionState => ({ ...s, tabs: s.tabs.map((t) => ({ ...t, agent: false })) })

function record(s: SessionState, planned: PlannedStep, extra: Partial<Step> = {}): SessionState {
  const step: Step = { n: s.log.length + 1, title: planned.title, target: planned.target, verdict: planned.verdict, ...extra }
  const runs = step.verdict === 'allow'
  const tabs = runs && planned.navigatesTo ? s.tabs.map((t) => (t.agent ? navigate(t, planned.navigatesTo!) : t)) : s.tabs
  return { ...s, tabs, log: [...s.log, step] }
}

export function reducer(s: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'tick': {
      if (s.agent !== 'acting') return s
      const [next, ...rest] = s.plan
      if (!next) return { ...releaseAgentTab(s), agent: 'idle', lastUpdate: action.now }
      if (next.verdict === 'review') return { ...s, plan: rest, agent: 'waiting', pending: { ...next, n: s.log.length + 1 }, lastUpdate: action.now }
      return { ...record(s, next), plan: rest, lastUpdate: action.now }
    }
    case 'approve':
      if (!s.pending || s.agent !== 'waiting') return s
      return { ...record(s, { ...s.pending, verdict: 'allow' }, { resolution: 'approved' }), pending: undefined, agent: 'acting', lastUpdate: action.now }
    case 'deny':
      if (!s.pending || s.agent !== 'waiting') return s
      return { ...releaseAgentTab(record(s, { ...s.pending, verdict: 'deny' }, { resolution: 'denied' })), pending: undefined, plan: [], agent: 'idle', lastUpdate: action.now }
    case 'pause':
      if (s.agent !== 'acting' && s.agent !== 'waiting') return s
      return { ...s, agent: 'stopped', lastUpdate: action.now }
    case 'resume':
      if (s.agent !== 'stopped') return s
      return { ...s, agent: s.pending ? 'waiting' : 'acting', lastUpdate: action.now }
    case 'selectTab':
      return { ...s, activeTabId: action.id }
    case 'closeTab': {
      const i = s.tabs.findIndex((t) => t.id === action.id)
      if (i < 0 || agentHolds(s, s.tabs[i])) return s
      const tabs = s.tabs.filter((t) => t.id !== action.id)
      if (tabs.length === 0) {
        const fresh = makeTab(NEW_TAB_URL)
        return { ...s, tabs: [fresh], activeTabId: fresh.id }
      }
      const activeTabId = s.activeTabId === action.id ? tabs[Math.max(0, i - 1)].id : s.activeTabId
      return { ...s, tabs, activeTabId }
    }
    case 'newTab': {
      const tab = makeTab(NEW_TAB_URL)
      return { ...s, tabs: [...s.tabs, tab], activeTabId: tab.id }
    }
    case 'back':
    case 'forward': {
      const delta = action.type === 'back' ? -1 : 1
      return {
        ...s,
        tabs: s.tabs.map((t) => {
          if (t.id !== s.activeTabId || agentHolds(s, t)) return t
          const index = t.index + delta
          return index < 0 || index >= t.history.length ? t : { ...t, index }
        }),
      }
    }
  }
}

/**
 * DEMO session: a scripted agent run so the UI can be exercised without a
 * live gateway. Replace with steps and verdicts from HALO's gateway.
 */
export function demoSession(now: number): SessionState {
  const agentTab = makeTab('https://www.example.com/cart', true)
  return {
    task: 'Buy the headphones in my cart',
    agent: 'acting',
    tabs: [agentTab, makeTab('https://www.example.com/orders'), makeTab('https://docs.example.org/api')],
    activeTabId: agentTab.id,
    log: [],
    lastUpdate: now,
    plan: [
      { title: 'Read cart contents', target: 'section#cart', verdict: 'allow' },
      { title: 'Click “Checkout”', target: 'a[href="/checkout"]', verdict: 'allow', navigatesTo: 'https://checkout.example.com/pay' },
      { title: 'Fill shipping address', target: 'form#shipping', verdict: 'allow' },
      { title: 'Send address to a tracking widget', target: 'POST https://track.adnet-example.net/collect', verdict: 'quarantine' },
      {
        title: 'Click “Place order”',
        target: 'button[type=submit]',
        verdict: 'review',
        navigatesTo: 'https://checkout.example.com/done',
        prompt: {
          title: 'Place order for $84.20?',
          consequence: 'The agent will pay with your saved card ending 4471.',
          request: 'POST https://checkout.example.com/pay',
          approveLabel: 'Place order',
        },
      },
      { title: 'Read order confirmation', target: 'main#confirmation', verdict: 'allow' },
    ],
  }
}
