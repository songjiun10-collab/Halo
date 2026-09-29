export type MemoryPolicy = 'budgeted' | 'user_override'
export type RuntimeConnection = 'disconnected' | 'connecting' | 'connected' | 'unavailable'
export type RuntimeServiceState = 'stopped' | 'starting' | 'running' | 'recovering' | 'unavailable'
export interface BackgroundRuntimeSnapshot { connection: RuntimeConnection; service: RuntimeServiceState; memoryPolicy: MemoryPolicy; launchAgentInstalled?: boolean }
export interface BackgroundRuntimeApi {
  getBackgroundRuntimeSnapshot(): Promise<BackgroundRuntimeSnapshot>
  attachBackgroundRuntime(): Promise<BackgroundRuntimeSnapshot>
  detachBackgroundRuntime(): Promise<void>
  setMemoryPolicy(mode: MemoryPolicy): Promise<BackgroundRuntimeSnapshot>
  stopBackgroundService(): Promise<BackgroundRuntimeSnapshot>
  onBackgroundRuntimeEvent(callback: (snapshot: BackgroundRuntimeSnapshot) => void): () => void
}
export interface BackgroundRuntimeState { connection: RuntimeConnection; service: RuntimeServiceState; memoryPolicy: MemoryPolicy; launchAgentInstalled?: boolean; error: string | null }

export const MEMORY_OVERRIDE_WARNING = 'For the next parent run, HALO admission limits and automatic memory-pressure pauses will be disabled. Monitoring and warnings remain active. OS memory pressure may slow down or terminate the app.'

const connections = new Set<RuntimeConnection>(['disconnected', 'connecting', 'connected', 'unavailable'])
const services = new Set<RuntimeServiceState>(['stopped', 'starting', 'running', 'recovering', 'unavailable'])

const initial = (): BackgroundRuntimeState => ({ connection: 'disconnected', service: 'stopped', memoryPolicy: 'budgeted', error: null })

/** Local service attachment is idempotent and deliberately separate from task submission. */
export class BackgroundRuntimeStore {
  private state: BackgroundRuntimeState
  private api?: Partial<BackgroundRuntimeApi>
  private listeners = new Set<() => void>()
  private detachEvents?: () => void
  private attachFlight?: Promise<boolean>
  constructor(api?: Partial<BackgroundRuntimeApi>) { this.api = api; this.state = initial() }
  getState = () => this.state
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  private update(patch: Partial<BackgroundRuntimeState>) { this.state = { ...this.state, ...patch }; this.listeners.forEach((listener) => listener()) }
  private apply(snapshot: BackgroundRuntimeSnapshot) {
    if (!snapshot || !connections.has(snapshot.connection) || !services.has(snapshot.service) || (snapshot.memoryPolicy !== 'budgeted' && snapshot.memoryPolicy !== 'user_override') || (snapshot.launchAgentInstalled !== undefined && typeof snapshot.launchAgentInstalled !== 'boolean')) throw new Error('invalid background runtime snapshot')
    this.update({ connection: snapshot.connection, service: snapshot.service, memoryPolicy: snapshot.memoryPolicy, ...(snapshot.launchAgentInstalled === undefined ? {} : { launchAgentInstalled: snapshot.launchAgentInstalled }), error: null })
  }
  private receive(snapshot: BackgroundRuntimeSnapshot) {
    try { this.apply(snapshot) }
    catch (error) { this.update({ connection: 'unavailable', service: 'unavailable', error: error instanceof Error ? error.message : 'Invalid background runtime snapshot' }) }
  }
  connect = () => {
    if (!this.api?.onBackgroundRuntimeEvent || this.detachEvents) return () => this.detachEvents?.()
    this.detachEvents = this.api.onBackgroundRuntimeEvent((snapshot) => this.receive(snapshot))
    return () => { this.detachEvents?.(); this.detachEvents = undefined }
  }
  connectRuntime = () => {
    if (!this.api?.attachBackgroundRuntime) return Promise.resolve(false)
    if (this.state.connection === 'connected') return Promise.resolve(true)
    if (this.attachFlight) return this.attachFlight
    this.update({ connection: 'connecting', error: null })
    this.attachFlight = this.api.attachBackgroundRuntime().then((snapshot) => { this.apply(snapshot); return snapshot.connection === 'connected' }).catch((error) => {
      this.update({ connection: 'unavailable', service: 'unavailable', error: error instanceof Error ? error.message : String(error) }); return false
    }).finally(() => { this.attachFlight = undefined })
    return this.attachFlight
  }
  refresh = async () => {
    if (!this.api?.getBackgroundRuntimeSnapshot) return false
    try { this.apply(await this.api.getBackgroundRuntimeSnapshot()); return true }
    catch (error) { this.update({ connection: 'unavailable', service: 'unavailable', error: error instanceof Error ? error.message : String(error) }); return false }
  }
  setMemoryPolicy = async (mode: MemoryPolicy, confirmed = false) => {
    if (!this.api?.setMemoryPolicy || (mode !== 'budgeted' && mode !== 'user_override') || (mode === 'user_override' && !confirmed)) return false
    try { this.apply(await this.api.setMemoryPolicy(mode)); return true }
    catch (error) { this.update({ error: error instanceof Error ? error.message : String(error) }); return false }
  }
  detach = async () => {
    if (!this.api?.detachBackgroundRuntime) return false
    try { await this.api.detachBackgroundRuntime(); this.update({ connection: 'disconnected' }); return true }
    catch (error) { this.update({ error: error instanceof Error ? error.message : String(error) }); return false }
  }
  stopService = async () => {
    if (!this.api?.stopBackgroundService) return false
    try { this.apply(await this.api.stopBackgroundService()); return true }
    catch (error) { this.update({ error: error instanceof Error ? error.message : String(error) }); return false }
  }
}
