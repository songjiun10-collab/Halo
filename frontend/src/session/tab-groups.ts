/** Sidebar tab groups. Pure functions over a plain list so every rule is testable; the UI only calls these. */
export interface TabGroup { id: string; name: string; collapsed: boolean; tabIds: string[] }
export type TabGroups = TabGroup[]

export const TAB_GROUPS_KEY = 'halo.tabGroups'
const MAX_NAME = 40

const clean = (name: string, fallback: string) => name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || fallback

/** A group with no tabs is not a group: it disappears (moving the last tab out closes the group, as people expect). */
function dropEmpty(groups: TabGroups): TabGroups {
  return groups.filter((group) => group.tabIds.length > 0)
}

export function groupOf(groups: TabGroups, tabId: string): TabGroup | undefined {
  return groups.find((group) => group.tabIds.includes(tabId))
}

/** A tab is in at most one group, so adding it anywhere first takes it out of where it was. */
function without(groups: TabGroups, tabId: string): TabGroups {
  return dropEmpty(groups.map((group) => (group.tabIds.includes(tabId) ? { ...group, tabIds: group.tabIds.filter((id) => id !== tabId) } : group)))
}

export function createGroup(groups: TabGroups, tabId: string, id: string, name = 'New group'): TabGroups {
  return [...without(groups, tabId), { id, name: clean(name, 'New group'), collapsed: false, tabIds: [tabId] }]
}

export function addToGroup(groups: TabGroups, groupId: string, tabId: string): TabGroups {
  if (!groups.some((group) => group.id === groupId)) return groups
  return without(groups, tabId).map((group) => (group.id === groupId ? { ...group, tabIds: [...group.tabIds, tabId] } : group))
}

/** Move one tab out of its group. If it was the last tab, the group closes with it. */
export function removeFromGroup(groups: TabGroups, tabId: string): TabGroups {
  return without(groups, tabId)
}

/** Dissolve one group; its tabs stay open and become ungrouped. */
export function ungroup(groups: TabGroups, groupId: string): TabGroups {
  return groups.filter((group) => group.id !== groupId)
}

/** One action undoes every group, so an accidental "group everything" is one click to reverse. */
export function ungroupAll(): TabGroups {
  return []
}

export function renameGroup(groups: TabGroups, groupId: string, name: string): TabGroups {
  return groups.map((group) => (group.id === groupId ? { ...group, name: clean(name, group.name) } : group))
}

export function toggleCollapsed(groups: TabGroups, groupId: string): TabGroups {
  return groups.map((group) => (group.id === groupId ? { ...group, collapsed: !group.collapsed } : group))
}

/** Drop tabs that were closed and groups that became empty. Returns the same array when nothing changed. */
export function pruneGroups(groups: TabGroups, liveTabIds: readonly string[]): TabGroups {
  const live = new Set(liveTabIds)
  let changed = false
  const next = groups.map((group) => {
    const tabIds = group.tabIds.filter((id) => live.has(id))
    if (tabIds.length !== group.tabIds.length) changed = true
    return tabIds.length === group.tabIds.length ? group : { ...group, tabIds }
  })
  const kept = dropEmpty(next)
  if (kept.length !== next.length) changed = true
  return changed ? kept : groups
}

/** Stored data is untrusted: keep only well-formed groups, and a tab in two groups stays in the first. */
export function parseGroups(raw: unknown): TabGroups {
  if (!Array.isArray(raw)) return []
  const seenTabs = new Set<string>()
  const seenIds = new Set<string>()
  const out: TabGroups = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { id, name, collapsed, tabIds } = item as Record<string, unknown>
    if (typeof id !== 'string' || !id || seenIds.has(id) || !Array.isArray(tabIds)) continue
    const ids = tabIds.filter((t): t is string => typeof t === 'string' && t !== '' && !seenTabs.has(t))
    const unique = [...new Set(ids)]
    if (!unique.length) continue
    seenIds.add(id)
    unique.forEach((t) => seenTabs.add(t))
    out.push({ id, name: clean(typeof name === 'string' ? name : '', 'Group'), collapsed: collapsed === true, tabIds: unique })
  }
  return out
}

export function loadGroups(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): TabGroups {
  try { return parseGroups(JSON.parse(storage?.getItem(TAB_GROUPS_KEY) ?? 'null')) } catch { return [] }
}

export function saveGroups(groups: TabGroups, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage) {
  try { storage?.setItem(TAB_GROUPS_KEY, JSON.stringify(groups)) } catch { /* storage unavailable: groups last for this window only */ }
}
