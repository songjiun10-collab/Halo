import { getDomain, parse } from 'tldts'

type ImportedSession = { domain: string; cookieCount: number; source: string; importedAt: string }
type ImportedSettings = { browser: string; importedAt: string; bookmarks: number; searchEngines: number; hasHomepage: boolean; startupUrls: number }
type ProfileImportApi = {
  listImportedSessions?: () => Promise<unknown>
  getSessionAllowlist?: () => Promise<unknown>
  setSessionAllowlist?: (domains: string[]) => Promise<unknown>
  importSessions?: (input: { browser: 'chrome'; profile: 'Default' }) => Promise<unknown>
  removeImportedSession?: (domain: string) => Promise<unknown>
  importBrowserSettings?: (input: { browser: 'chrome'; profile: 'Default' }) => Promise<unknown>
  getImportedSettings?: () => Promise<unknown>
}
type ProfileImportState = {
  available: boolean
  busy: boolean
  error: string | null
  message: string | null
  sessions: ImportedSession[]
  allowlist: string[]
  settings: ImportedSettings | null
}

const emptyState = (available: boolean): ProfileImportState => ({ available, busy: false, error: null, message: null, sessions: [], allowlist: [], settings: null })
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const requiredMethods: (keyof ProfileImportApi)[] = ['listImportedSessions', 'getSessionAllowlist', 'setSessionAllowlist', 'importSessions', 'removeImportedSession', 'importBrowserSettings', 'getImportedSettings']
const statusMessage: Record<string, string> = {
  permission_required: 'Chrome Keychain permission is required before cookies can be imported.',
  not_found: 'Could not find the requested Chrome profile.',
  decrypt_failed: 'Chrome cookies could not be decrypted.',
  locked: 'The Chrome profile is locked. Close Chrome and try again.',
  unsupported: 'This browser profile is not supported for import.',
}

function cleanSessions(value: unknown): ImportedSession[] {
  if (!Array.isArray(value)) throw new Error('Unexpected reply while loading imported sessions.')
  return value.map((item) => {
    if (!isRecord(item) || typeof item.domain !== 'string' || !item.domain || !Number.isSafeInteger(item.cookieCount) || (item.cookieCount as number) < 0 || typeof item.source !== 'string' || typeof item.importedAt !== 'string') {
      throw new Error('Unexpected reply while loading imported sessions.')
    }
    return { domain: item.domain, cookieCount: item.cookieCount as number, source: item.source, importedAt: item.importedAt }
  })
}

function cleanAllowlist(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((domain) => typeof domain !== 'string')) throw new Error('Unexpected reply while loading the session allowlist.')
  return [...new Set(value as string[])]
}

function cleanSettings(value: unknown): ImportedSettings | null {
  if (value === null || value === undefined) return null
  if (!isRecord(value) || typeof value.browser !== 'string' || typeof value.importedAt !== 'string' || !Array.isArray(value.bookmarks) || !Array.isArray(value.searchEngines) || !Array.isArray(value.startupUrls)) {
    throw new Error('Unexpected reply while loading imported browser settings.')
  }
  return {
    browser: value.browser,
    importedAt: value.importedAt,
    bookmarks: value.bookmarks.length,
    searchEngines: value.searchEngines.length,
    hasHomepage: typeof value.homepage === 'string' && value.homepage.length > 0,
    startupUrls: value.startupUrls.length,
  }
}

function normalizeDomain(input: string): string | null {
  const domain = input.trim().toLowerCase().replace(/\.$/, '')
  if (!domain || domain.length > 253 || domain.includes('/') || domain.includes(':') || domain.includes('@') || /\s/.test(domain)) return null
  const parsed = parse(domain, { allowPrivateDomains: true })
  const registrable = getDomain(domain, { allowPrivateDomains: true })
  if (parsed.isIp || parsed.isSpecialUse || parsed.hostname !== domain || !registrable) return null
  return domain
}

export class ProfileImportStore {
  private readonly api: ProfileImportApi | undefined
  private readonly state: ProfileImportState

  constructor(api?: unknown) {
    this.api = isRecord(api) ? api as ProfileImportApi : undefined
    this.state = emptyState(Boolean(this.api && requiredMethods.every((name) => typeof this.api?.[name] === 'function')))
  }

  getState(): ProfileImportState {
    return { ...this.state, sessions: this.state.sessions.map((item) => ({ ...item })), allowlist: [...this.state.allowlist], settings: this.state.settings ? { ...this.state.settings } : null }
  }

  async refresh(): Promise<boolean> {
    if (!this.state.available || !this.api) return false
    try {
      const [sessions, allowlist, settings] = await Promise.all([
        this.api.listImportedSessions!(), this.api.getSessionAllowlist!(), this.api.getImportedSettings!(),
      ])
      const clean = { sessions: cleanSessions(sessions), allowlist: cleanAllowlist(allowlist), settings: cleanSettings(settings) }
      Object.assign(this.state, clean, { error: null })
      return true
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : 'Unexpected reply while loading browser data.'
      return false
    }
  }

  private async command(run: () => Promise<string | null | false>): Promise<boolean> {
    if (!this.state.available || this.state.busy) return false
    this.state.busy = true
    this.state.error = null
    this.state.message = null
    try {
      const message = await run()
      if (message === false) return false
      if (message) this.state.message = message
      return true
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : 'Browser profile action failed.'
      return false
    } finally {
      this.state.busy = false
    }
  }

  importFromChrome(): Promise<boolean> {
    return this.command(async () => {
      const result = await this.api!.importSessions!({ browser: 'chrome', profile: 'Default' })
      if (!isRecord(result) || typeof result.status !== 'string') throw new Error('Unexpected reply while importing Chrome cookies.')
      if (result.status !== 'ok') {
        if (!statusMessage[result.status]) throw new Error('Unexpected reply while importing Chrome cookies.')
        this.state.message = statusMessage[result.status]
        return false
      }
      if (!Number.isSafeInteger(result.imported) || (result.imported as number) < 0) throw new Error('Unexpected reply while importing Chrome cookies.')
      await this.refresh()
      return `Imported ${result.imported} cookies from Chrome.`
    })
  }

  addDomain(input: string): Promise<boolean> {
    return this.command(async () => {
      const domain = normalizeDomain(input)
      if (!domain) throw new Error('Enter a valid domain name, not a URL or local address.')
      if (this.state.allowlist.includes(domain)) return false
      const result = await this.api!.setSessionAllowlist!([...this.state.allowlist, domain])
      this.state.allowlist = cleanAllowlist(result)
      return null
    })
  }

  removeDomain(input: string): Promise<boolean> {
    return this.command(async () => {
      const domain = normalizeDomain(input)
      if (!domain) throw new Error('Enter a valid domain name, not a URL or local address.')
      if (!this.state.allowlist.includes(domain)) return false
      const result = await this.api!.setSessionAllowlist!(this.state.allowlist.filter((item) => item !== domain))
      this.state.allowlist = cleanAllowlist(result)
      return null
    })
  }

  removeSession(domain: string): Promise<boolean> {
    return this.command(async () => {
      const normalized = normalizeDomain(domain)
      if (!normalized) throw new Error('Enter a valid domain name, not a URL or local address.')
      const removed = await this.api!.removeImportedSession!(normalized)
      if (removed !== true) throw new Error('The imported session could not be removed.')
      this.state.sessions = this.state.sessions.filter((item) => item.domain !== normalized)
      return null
    })
  }

  importSettings(): Promise<boolean> {
    return this.command(async () => {
      const result = await this.api!.importBrowserSettings!({ browser: 'chrome', profile: 'Default' })
      if (!isRecord(result) || typeof result.status !== 'string') throw new Error('Unexpected reply while importing browser settings.')
      if (result.status !== 'ok' || !Number.isSafeInteger(result.bookmarks) || !Number.isSafeInteger(result.searchEngines)) {
        throw new Error(statusMessage[result.status] ?? 'Unexpected reply while importing browser settings.')
      }
      await this.refresh()
      return `Imported ${result.bookmarks} bookmarks and ${result.searchEngines} search engines from Chrome.`
    })
  }
}
