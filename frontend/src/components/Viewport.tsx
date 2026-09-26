import { pageTitle } from '../session/pages'
import { currentUrl } from '../session/session'
import type { Tab } from '../session/types'

/**
 * Stand-in for the page engine's surface. The page keeps the site's own look;
 * HALO draws only the outline around the element the agent is about to use.
 */
export function Viewport({ tab, target }: { tab: Tab; target?: string }) {
  const url = currentUrl(tab)
  const targetsOrder = target === 'button[type=submit]'
  let body
  if (url.endsWith('/done')) {
    body = (
      <>
        <h2>Order placed</h2>
        <p>Order #4471 · Noise-cancelling headphones · <span className="num">$84.20</span></p>
      </>
    )
  } else if (url.includes('checkout.')) {
    body = (
      <>
        <h2>Your order</h2>
        <dl className="hx-site__rows">
          <div><dt>Noise-cancelling headphones</dt><dd className="num">$79.00</dd></div>
          <div><dt>Shipping</dt><dd className="num">$5.20</dd></div>
          <div className="total"><dt>Total</dt><dd className="num">$84.20</dd></div>
        </dl>
        <span className="hx-site__btn" data-agent-target={targetsOrder || undefined}>Place order</span>
      </>
    )
  } else if (url.startsWith('halo://')) {
    body = (
      <div className="hx-site__empty">
        <p className="hx-site__empty-title">New tab</p>
        <p>The agent works in its own tab. Pages you open here aren’t shared with it.</p>
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
    <main id="hx-page" className="hx-site" role="tabpanel" aria-labelledby={`tab-${tab.id}`} tabIndex={-1}>
      {body}
    </main>
  )
}
