/** Where the open tabs live: a strip above the page, or the sidebar (vertical tabs, one place for tabs and address). */
export type TabLayout = 'horizontal' | 'vertical'

export const TAB_LAYOUT_KEY = 'halo.tabLayout'

/** Anything unreadable falls back to the strip, which is how Halo has always looked. */
export function parseTabLayout(raw: unknown): TabLayout {
  return raw === 'vertical' ? 'vertical' : 'horizontal'
}

export function otherTabLayout(layout: TabLayout): TabLayout {
  return layout === 'vertical' ? 'horizontal' : 'vertical'
}

export function loadTabLayout(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): TabLayout {
  try { return parseTabLayout(storage?.getItem(TAB_LAYOUT_KEY)) } catch { return 'horizontal' }
}

export function saveTabLayout(layout: TabLayout, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try { storage?.setItem(TAB_LAYOUT_KEY, layout) } catch { /* storage unavailable: the choice lasts for this window only */ }
}
