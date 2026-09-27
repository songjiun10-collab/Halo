import { tabTitle } from '../session/pages'
import { AGENT, currentUrl, NEW_TAB_URL } from '../session/session'
import type { Tab } from '../session/types'
import { HomeScreen } from './HomeScreen'

interface Props {
  tab: Tab
  target?: string
  driven: boolean
  /** A task already running or paused in another tab: offered from the home screen. */
  activeTask?: { text: string; tabId: string }
  onSelectTab: (id: string) => void
  onStartTask: (text: string) => void
}

/**
 * Stand-in for the page engine's surface. The page keeps the site's own look;
 * HALO draws only where Claude is about to act.
 */
export function Viewport({ tab, target, driven, activeTask, onSelectTab, onStartTask }: Props) {
  const url = currentUrl(tab)

  // halo://newtab is Halo's own surface, not a web page: it gets the dark chrome look,
  // never the site's white background.
  if (url === NEW_TAB_URL) {
    return (
      <main id="hx-page" className="hx-site hx-site--home" role="tabpanel" aria-labelledby={`tab-${tab.id}`} tabIndex={-1}>
        <HomeScreen activeTask={activeTask} onSelectTab={onSelectTab} onSubmit={onStartTask} />
      </main>
    )
  }

  let body
  if (url.endsWith('/done')) {
    body = (
      <>
        <h2>Order placed</h2>
        <p>Order #4471 · Noise-cancelling headphones · <span className="num">$84.20</span></p>
      </>
    )
  } else if (url.includes('checkout.')) {
    const targeted = target === 'button[type=submit]'
    body = (
      <>
        <h2>Your order</h2>
        <dl className="hx-site__rows">
          <div><dt>Noise-cancelling headphones</dt><dd className="num">$79.00</dd></div>
          <div><dt>Shipping</dt><dd className="num">$5.20</dd></div>
          <div className="total"><dt>Total</dt><dd className="num">$84.20</dd></div>
        </dl>
        <span className="hx-site__btn" data-claude-target={targeted || undefined}>
          Place order
        </span>
        {targeted && <p className="hx-sr">{AGENT} is about to click Place order.</p>}
      </>
    )
  } else {
    body = (
      <>
        <h2>{tabTitle(tab).split(' — ')[0]}</h2>
        <p>Sample page content.</p>
      </>
    )
  }
  return (
    <main id="hx-page" className="hx-site" role="tabpanel" aria-labelledby={`tab-${tab.id}`} tabIndex={-1} data-driven={driven || undefined}>
      {body}
      {driven && <p className="hx-sr">{AGENT} is driving this tab.</p>}
    </main>
  )
}
