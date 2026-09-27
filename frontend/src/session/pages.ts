import { NEW_TAB_URL, currentUrl } from './session'
import type { Tab } from './types'

/** Stand-in page titles; a real page engine supplies these once it's wired in. */
const titles: Record<string, string> = {
  [NEW_TAB_URL]: 'New tab',
}

export const pageTitle = (url: string) => titles[url] ?? url

/** A tab's title: a known page, else the title supplied when it was opened, else the URL. */
export const tabTitle = (tab: Tab) => {
  const url = currentUrl(tab)
  return titles[url] ?? tab.titles?.[url] ?? url
}
