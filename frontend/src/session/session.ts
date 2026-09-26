import type { AgentState, PlannedStep, SessionState, Step, Tab } from './types'

export const agentLabel: Record<AgentState, string> = {
  idle: 'Agent idle',
  acting: 'Agent is acting',
  waiting: 'Waiting for you',
  stopped: 'Agent stopped',
}


export type Action =
  | { type: 'tick'; now: number }
  | { type: 'approve'; now: number }
  | { type: 'deny'; now: number }
  | { type: 'stop'; now: number }
  | { type: 'resume'; now: number }
  | { type: 'selectTab'; id: string }
  | { type: 'closeTab'; id: string }
  | { type: 'newTab' }

let tabSeq = 0
const newTabId = () => `tab-${++tabSeq}`

/** Registrable domain for display: the last two host labels. */
export function splitUrl(url: string): { before: string; domain: string; after: string } {
  const m = /^(https?:\/\/)([^/]+)(.*)$/.exec(url)
  if (!m) return { before: '', domain: url, after: '' }
  const labels = m[2].split('.')
  const domain = labels.slice(-2).join('.')
  const sub = labels.slice(0, -2).join('.')
  return { before: m[1] + (sub ? sub + '.' : ''), domain, after: m[3] }
}

function appendStep(state: SessionState, planned: PlannedStep, extra: Partial<Step> = {}): SessionState {
  const step: Step = { n: state.log.length + 1, title: planned.title, target: planned.target, verdict: planned.verdict, ...extra }
  let tabs = state.tabs
  if (planned.navigatesTo && step.verdict === 'allow' && step.resolution !== 'denied') {
    const nav = planned.navigatesTo
    tabs = tabs.map((t) => (t.agent ? { ...t, url: nav.url, title: nav.title } : t))
  }
  return { ...state, tabs, log: [...state.log, step] }
}

export function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'tick': {
      if (state.agent !== 'acting') return state
      const [next, ...rest] = state.plan
      if (!next) return { ...state, agent: 'idle', tabs: state.tabs.map((t) => ({ ...t, agent: false })), lastUpdate: action.now }
      if (next.verdict === 'review') {
        return { ...state, plan: rest, agent: 'waiting', pending: { ...next, n: state.log.length + 1 }, lastUpdate: action.now }
      }
      return { ...appendStep(state, next), plan: rest, lastUpdate: action.now }
    }
    case 'approve': {
      if (!state.pending) return state
      const s = appendStep(state, { ...state.pending, verdict: 'allow' }, { resolution: 'approved' })
      return { ...s, pending: undefined, agent: 'acting', lastUpdate: action.now }
    }
    case 'deny': {
      if (!state.pending) return state
      const s = appendStep(state, { ...state.pending, verdict: 'deny' }, { resolution: 'denied' })
      return { ...s, pending: undefined, plan: [], agent: 'idle', tabs: s.tabs.map((t) => ({ ...t, agent: false })), lastUpdate: action.now }
    }
    case 'stop':
      if (state.agent === 'stopped' || state.agent === 'idle') return state
      return { ...state, agent: 'stopped', lastUpdate: action.now }
    case 'resume':
      if (state.agent !== 'stopped') return state
      return { ...state, agent: state.pending ? 'waiting' : 'acting', lastUpdate: action.now }
    case 'selectTab':
      return { ...state, activeTabId: action.id }
    case 'closeTab': {
      const tab = state.tabs.find((t) => t.id === action.id)
      // The agent's tab can only be closed by stopping the agent first.
      if (!tab || (tab.agent && state.agent !== 'stopped' && state.agent !== 'idle')) return state
      const tabs = state.tabs.filter((t) => t.id !== action.id)
      if (tabs.length === 0) {
        const fresh: Tab = { id: newTabId(), title: 'New tab', url: 'halo://newtab', agent: false }
        return { ...state, tabs: [fresh], activeTabId: fresh.id }
      }
      const i = state.tabs.findIndex((t) => t.id === action.id)
      const activeTabId = state.activeTabId === action.id ? tabs[Math.max(0, i - 1)].id : state.activeTabId
      return { ...state, tabs, activeTabId }
    }
    case 'newTab': {
      const tab: Tab = { id: newTabId(), title: 'New tab', url: 'halo://newtab', agent: false }
      return { ...state, tabs: [...state.tabs, tab], activeTabId: tab.id }
    }
  }
}

/**
 * DEMO session: a scripted agent run so the UI can be exercised without a
 * live gateway. Replace with data from HALO's gateway when it exposes a
 * session feed.
 */
export function demoSession(now: number): SessionState {
  const agentTab: Tab = { id: newTabId(), title: 'Example Store', url: 'https://www.example.com/cart', agent: true }
  return {
    task: 'Buy the headphones in my cart',
    agent: 'acting',
    tabs: [
      agentTab,
      { id: newTabId(), title: 'Order history', url: 'https://www.example.com/orders', agent: false },
      { id: newTabId(), title: 'API reference · Docs', url: 'https://docs.example.org/api', agent: false },
    ],
    activeTabId: agentTab.id,
    log: [],
    lastUpdate: now,
    plan: [
      { title: 'Read cart contents', target: 'section#cart', verdict: 'allow' },
      { title: 'Click “Checkout”', target: 'a[href="/checkout"]', verdict: 'allow', navigatesTo: { url: 'https://checkout.example.com/pay?step=1', title: 'Checkout — Example Store' } },
      { title: 'Fill shipping address', target: 'form#shipping', verdict: 'allow' },
      { title: 'Send address to tracking widget', target: 'POST https://track.adnet-example.net/collect', verdict: 'quarantine' },
      {
        title: 'Click “Place order”',
        target: 'button[type=submit] · checkout.example.com',
        verdict: 'review',
        prompt: {
          title: 'Place order for $84.20?',
          consequence: 'The agent will submit your saved card ending 4471 to this site.',
          request: 'POST https://checkout.example.com/pay',
        },
        navigatesTo: { url: 'https://checkout.example.com/done', title: 'Order placed — Example Store' },
      },
      { title: 'Read order confirmation', target: 'main#confirmation', verdict: 'allow' },
    ],
  }
}
