import { NEW_TAB_URL } from './session'

/** Stand-in page titles for the demo URLs; a real page engine supplies these. */
const titles: Record<string, string> = {
  'https://www.example.com/cart': 'Cart — Example Store',
  'https://www.example.com/orders': 'Order history — Example Store',
  'https://reviews.example.org/headphones': 'Headphone reviews — Example Reviews',
  'https://checkout.example.com/pay': 'Checkout — Example Store',
  'https://checkout.example.com/done': 'Order placed — Example Store',
  [NEW_TAB_URL]: 'New tab',
}

export const pageTitle = (url: string) => titles[url] ?? url
