import { pageTitle } from '../session/pages'
import { AGENT, currentUrl } from '../session/session'
import type { Tab } from '../session/types'

/** Where Claude is about to act: a soft halo on the element and a named cursor. */
function ClaudeCursor() {
  return (
    <span className="hx-cursor" aria-hidden="true">
      <svg viewBox="0 0 16 16" className="hx-cursor__arrow"><path d="M2 1.5l11 6.2-4.9 1.3-2 4.6z" /></svg>
      <span className="hx-cursor__name">{AGENT}</span>
    </span>
  )
}

/**
 * Stand-in for the page engine's surface. The page keeps the site's own look;
 * HALO draws only where Claude is about to act.
 */
export function Viewport({ tab, target }: { tab: Tab; target?: string }) {
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
          {targeted && <ClaudeCursor />}
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
    <main id="hx-page" className="hx-site" role="tabpanel" aria-labelledby={`tab-${tab.id}`} tabIndex={-1}>
      {body}
    </main>
  )
}
