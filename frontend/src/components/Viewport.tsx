import type { Tab } from '../session/types'

/**
 * Stand-in for the rendered web page. In the real browser this is the page
 * engine's surface; HALO only draws the agent-target outline over it.
 */
export function Viewport({ tab, target }: { tab: Tab; target?: string }) {
  const onPlaceOrder = target?.startsWith('button[type=submit]')
  let page
  if (tab.url.includes('/done')) {
    page = (
      <>
        <h4>Order placed</h4>
        <p>Order #4471 · Noise-cancelling headphones · $84.20</p>
      </>
    )
  } else if (tab.url.includes('checkout.')) {
    page = (
      <>
        <h4>Your order</h4>
        <div className="row"><span>Noise-cancelling headphones</span><span>$79.00</span></div>
        <div className="row"><span>Shipping</span><span>$5.20</span></div>
        <div className="row" style={{ fontWeight: 700 }}><span>Total</span><span>$84.20</span></div>
        <span className={`buy${onPlaceOrder ? ' hx-target' : ''}`}>Place order</span>
      </>
    )
  } else if (tab.url.startsWith('halo://')) {
    page = <div className="hx-empty">New tab</div>
  } else {
    page = (
      <>
        <h4>{tab.title}</h4>
        <div className="row"><span>Noise-cancelling headphones</span><span>$79.00</span></div>
        <span className="buy">Checkout</span>
      </>
    )
  }
  return (
    <main id="hx-viewport" className="hx-view" role="tabpanel" aria-label={`Page: ${tab.title}`}>
      {page}
    </main>
  )
}
