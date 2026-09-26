import { pageTitle } from '../session/pages'
import { AGENT, currentUrl } from '../session/session'
import type { Tab } from '../session/types'

/**
 * Stand-in for the page engine's surface. The page keeps the site's own look;
 * HALO draws only where Claude is about to act.
 */
export function Viewport({ tab, target, driven }: { tab: Tab; target?: string; driven: boolean }) {
  const url = currentUrl(tab)
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
  } else if (url.startsWith('halo://')) {
    body = (
      <div className="hx-site__empty">
        <p className="hx-site__empty-title">New tab</p>
        <p>{AGENT} can see this tab only when you hand it control.</p>
      </div>
    )
  } else {
    body = (
      <>
        <h2>{pageTitle(url).split(' — ')[0]}</h2>
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
