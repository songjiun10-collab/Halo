/**
 * Agent roster contract, checked against the local host (apps/computer-browser/
 * main/harness/agent-store.js, agent-service.js, agent-schedule.js, task-host.js
 * and preload/index.js). Every call shape here is the host's, not the design
 * hand-off's assumption; see docs/superpowers/specs/2026-10-01-agent-roster-and-teams-design.md.
 */
import type { HostSettings, TaskSummary } from '../session/api'
import type { ChildPlanSummary } from '../session/child-agents'

export type AvatarShape = 'circle' | 'square' | 'bag' | 'star' | 'drop' | 'cloud' | 'triangle' | 'hex'
export type AvatarColor = 'brown' | 'yellow' | 'blue' | 'gray' | 'red' | 'green' | 'purple' | 'orange'
export interface Avatar { shape: AvatarShape; color: AvatarColor }
/** Single-agent capabilities the host accepts; only available ones can be saved. */
export type AgentCapability = 'browser' | 'research' | 'computer_use'

interface Stamp { generation: number; createdAt: string; updatedAt: string; archived: boolean; pinned: boolean }
export interface AgentRecord extends Stamp { id: string; name: string; title: string; description: string; avatar: Avatar; instructions: string; capabilityId: AgentCapability; mcpProviders: string[] | null; model?: string | null; persistentBrowser: boolean }
export interface TeamRecord extends Stamp { id: string; name: string; title: string; description: string; avatar: Avatar; memberAgentIds: string[] }
export interface AgentInput { id?: string; name: string; title: string; description: string; avatar: Avatar; instructions: string; capabilityId: AgentCapability; mcpProviders?: string[] | null; model?: string | null; persistentBrowser?: boolean }
export interface TeamInput { id?: string; name: string; title: string; description: string; avatar: Avatar; memberAgentIds: string[] }

export type OwnerKind = 'agent' | 'team'
export interface OwnerRef { kind: OwnerKind; id: string }
/** Exactly one of agentId / teamId, as agent-service.js target() requires. */
type OwnerArg = { agentId: string } | { teamId: string }

export interface ConversationLink { taskId: string; kind: OwnerKind; ownerId: string; generation: number; createdAt: string; seenState: TaskSummary['state'] | null; task: TaskSummary | null }
export interface RosterStatus { running: number; awaitingUser: number; hasUnread: boolean; lastConversation: { taskId: string; createdAt: string; originalRequest: string | null; state: string | null } | null }
export interface AgentRoster { agents: (AgentRecord & { status: RosterStatus })[]; teams: (TeamRecord & { status: RosterStatus })[] }
/** Content-free notice; the UI re-reads the roster. */
export interface RosterNotice { kind: OwnerKind; id: string; change: string }

export interface McpProvider { id: string; label: string; enabled: boolean }

export type ScheduleTrigger =
  | { kind: 'calendar'; days: number[]; time: string; timeZone: string }
  | { kind: 'interval'; everyMs: number; anchor: string }
  | { kind: 'once'; at: string }
export type ScheduleOnApproval = 'pause' | 'deny'
export interface ScheduleInput { id?: string; kind: OwnerKind; ownerId: string; request: string; trigger: ScheduleTrigger; onApproval: ScheduleOnApproval; maxPlannerCalls: number; enabled: boolean }
export interface ScheduleRecord extends ScheduleInput { id: string; disabledReason: string | null; armedAt: string; createdAt: string; updatedAt: string; lastOccurrenceAt: string | null; lastTaskId: string | null; lastError: string | null; consecutiveFailures: number; skippedCount: number }

export interface AgentApi {
  getHostSettings?(): Promise<HostSettings>
  listAgents(): Promise<AgentRecord[]>
  saveAgent(input: AgentInput): Promise<AgentRecord>
  archiveAgent(agentId: string): Promise<AgentRecord>
  duplicateAgent(agentId: string): Promise<AgentRecord>
  listTeams(): Promise<TeamRecord[]>
  saveTeam(input: TeamInput): Promise<TeamRecord>
  archiveTeam(teamId: string): Promise<TeamRecord>
  startAgentTask(input: OwnerArg & { request: string }): Promise<{ taskId: string }>
  listAgentConversations(input: OwnerArg): Promise<ConversationLink[]>
  markAgentConversationsRead(input: OwnerArg): Promise<{ marked: number }>
  getAgentRoster(): Promise<AgentRoster>
  setAgentPinned(input: { kind: OwnerKind; id: string; pinned: boolean }): Promise<AgentRecord | TeamRecord>
  onAgentRosterEvent(callback: (notice: RosterNotice) => void): () => void
  /** Optional: the same preload task stream the session view uses; absent in minimal hosts. */
  onTaskEvent?(callback: (event: { taskId: string; snapshot: { state: string; pauseReason?: string | null } }) => void): () => void
  listAgentSchedules(): Promise<ScheduleRecord[]>
  saveAgentSchedule(input: ScheduleInput): Promise<ScheduleRecord>
  deleteAgentSchedule(scheduleId: string): Promise<ScheduleRecord>
  listMcpProviders(): Promise<McpProvider[]>
  getChildPlan(taskId: string): Promise<ChildPlanSummary | null>
}

export const AGENT_METHODS = [
  'listAgents', 'saveAgent', 'archiveAgent', 'duplicateAgent', 'listTeams', 'saveTeam', 'archiveTeam',
  'startAgentTask', 'listAgentConversations', 'markAgentConversationsRead', 'getAgentRoster', 'setAgentPinned',
  'onAgentRosterEvent', 'listAgentSchedules', 'saveAgentSchedule', 'deleteAgentSchedule', 'listMcpProviders', 'getChildPlan',
] as const satisfies readonly (keyof AgentApi)[]

/** The Agent view appears only when the preload exposes the whole roster API. */
export function agentApiFrom(candidate: unknown): AgentApi | null {
  if (!candidate || typeof candidate !== 'object') return null
  const record = candidate as Record<string, unknown>
  return AGENT_METHODS.every((name) => typeof record[name] === 'function') ? (candidate as AgentApi) : null
}
export const getAgentApi = () => agentApiFrom((globalThis as { haloBrowser?: unknown }).haloBrowser)

// Team chat room (main/harness/room-orchestrator.js). A room is addressed by its team id.
export type RoomMessageKind = 'say' | 'pass' | 'propose_task' | 'task_started' | 'notice'
export interface RoomMessage { messageId: string; roomId: string; author: string; kind: RoomMessageKind; text: string; at: string; taskId?: string; originMessageId?: string; error?: string }
export interface RoomRound { active: boolean; turn: number; speakerId: string | null }
export interface Room { roomId: string; teamId: string; messages: RoomMessage[]; round: RoomRound }
export interface RoomSummary { roomId: string; teamId: string; name: string; archived: boolean; lastMessage: RoomMessage | null; active: boolean }
export type RoomEvent = { roomId: string; message: RoomMessage } | { roomId: string; round: RoomRound }
export interface RoomApi {
  listRooms(): Promise<RoomSummary[]>
  getRoom(teamId: string): Promise<Room>
  postRoomMessage(input: { teamId: string; text: string }): Promise<RoomMessage>
  stopRoomRound(teamId: string): Promise<{ stopped: boolean }>
  onRoomEvent(callback: (event: RoomEvent) => void): () => void
}
export const ROOM_METHODS = ['listRooms', 'getRoom', 'postRoomMessage', 'stopRoomRound', 'onRoomEvent'] as const satisfies readonly (keyof RoomApi)[]
/** Rooms are optional: an older preload without them still gets the rest of the Agent view. */
export function roomApiFrom(candidate: unknown): RoomApi | null {
  if (!candidate || typeof candidate !== 'object') return null
  const record = candidate as Record<string, unknown>
  return ROOM_METHODS.every((name) => typeof record[name] === 'function') ? (candidate as RoomApi) : null
}
export const getRoomApi = () => roomApiFrom((globalThis as { haloBrowser?: unknown }).haloBrowser)
/** Folds one pushed event into a room's view; other rooms and repeats are ignored. */
export function applyRoomEvent(state: { messages: RoomMessage[]; round: RoomRound }, teamId: string, event: RoomEvent) {
  if (event.roomId !== teamId) return state
  if ('round' in event) return { ...state, round: event.round }
  if (state.messages.some((m) => m.messageId === event.message.messageId)) return state
  return { ...state, messages: [...state.messages, event.message] }
}

const ownerArg = (owner: OwnerRef): OwnerArg => owner.kind === 'agent' ? { agentId: owner.id } : { teamId: owner.id }
export const startTask = (api: AgentApi, owner: OwnerRef, request: string) => api.startAgentTask({ ...ownerArg(owner), request })
export const listConversations = (api: AgentApi, owner: OwnerRef) => api.listAgentConversations(ownerArg(owner))
/** The host marks every listed conversation of the owner; it takes no task ids. */
export const markRead = (api: AgentApi, owner: OwnerRef) => api.markAgentConversationsRead(ownerArg(owner))
export const setPinned = (api: AgentApi, owner: OwnerRef, pinned: boolean) => api.setAgentPinned({ kind: owner.kind, id: owner.id, pinned })

export interface AgentFields { name: string; title: string; description: string; instructions: string; avatar: Avatar; model?: string | null; capabilityId?: AgentCapability }
/** Capability is user-selectable; omitted fields keep the agent's saved capability. */
export function agentInput(existing: AgentRecord | undefined, fields: AgentFields): AgentInput {
  return {
    ...(existing ? { id: existing.id } : {}),
    name: fields.name.trim(), title: fields.title.trim(), description: fields.description.trim(),
    avatar: { shape: fields.avatar.shape, color: fields.avatar.color }, instructions: fields.instructions,
    capabilityId: fields.capabilityId ?? existing?.capabilityId ?? 'browser',
    // null runs the host's planner setting; an id pins this agent's tasks to it.
    ...(fields.model !== undefined ? { model: fields.model } : {}),
  }
}
/** Only the explicit browser-profile control should write this preference. */
export const savePersistentBrowser = (api: AgentApi, agent: AgentRecord, persistentBrowser: boolean) =>
  api.saveAgent({ ...agentInput(agent, agent), persistentBrowser })
/** MCP scope is stored on the agent: null inherits the host set, an array narrows it. */
export const saveMcpScope = (api: AgentApi, agent: AgentRecord, mcpProviders: string[] | null) =>
  api.saveAgent({ ...agentInput(agent, agent), mcpProviders })

export function scheduleInput(record: ScheduleRecord | ScheduleInput): ScheduleInput {
  const { id, kind, ownerId, request, trigger, onApproval, maxPlannerCalls, enabled } = record
  return { ...(id ? { id } : {}), kind, ownerId, request, trigger, onApproval, maxPlannerCalls, enabled }
}
export const schedulesFor = (records: ScheduleRecord[], owner: OwnerRef) => records.filter((s) => s.kind === owner.kind && s.ownerId === owner.id)
export const blankSchedule = (owner: OwnerRef, timeZone: string): ScheduleInput => ({
  kind: owner.kind, ownerId: owner.id, request: '',
  trigger: { kind: 'calendar', days: [1, 2, 3, 4, 5], time: '09:00', timeZone },
  onApproval: 'pause', maxPlannerCalls: 40, enabled: true,
})
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Host limits (shared/schedule-contracts.js): an interval is 1 min..366 days.
const MIN_INTERVAL_MS = 60_000, MAX_INTERVAL_MS = 366 * 86_400_000
/** A fresh trigger of `kind`: hourly from now, once in an hour, or weekdays at 09:00. */
export function switchTrigger(kind: ScheduleTrigger['kind'], timeZone: string, nowMs = Date.now()): ScheduleTrigger {
  if (kind === 'interval') return { kind, everyMs: 3_600_000, anchor: new Date(nowMs).toISOString() }
  if (kind === 'once') return { kind, at: new Date(nowMs + 3_600_000).toISOString() }
  return { kind, days: [1, 2, 3, 4, 5], time: '09:00', timeZone }
}
/** The first thing the host would reject, worded for the form; null when it is fine. */
export function triggerProblem(trigger: ScheduleTrigger, nowMs = Date.now()): string | null {
  if (trigger.kind === 'interval') return trigger.everyMs < MIN_INTERVAL_MS ? 'Repeat at least every minute.' : trigger.everyMs > MAX_INTERVAL_MS ? 'Repeat at most once a year.' : null
  if (trigger.kind === 'once') { const at = Date.parse(trigger.at); return Number.isFinite(at) && at > nowMs ? null : 'Pick a time in the future.' }
  if (!trigger.days.length) return 'Pick at least one day.'
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time) ? null : 'Use a time like 09:00.'
}
/** ISO instant <-> the local wall clock a datetime-local input shows. */
export function toLocalInput(iso: string) {
  const d = new Date(iso), p = (n: number) => String(n).padStart(2, '0')
  return Number.isNaN(+d) ? '' : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
export function fromLocalInput(value: string): string | null {
  const d = new Date(value)
  return value && !Number.isNaN(+d) ? d.toISOString() : null
}
export function scheduleLabel(trigger: ScheduleTrigger) {
  if (trigger.kind === 'interval') return `every ${Math.round(trigger.everyMs / 60_000)} min`
  if (trigger.kind === 'once') return `once at ${trigger.at}`
  const d = trigger.days
  const days = d.length === 7 ? 'every day' : d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x)) ? 'weekdays' : d.map((i) => DAY_NAMES[i - 1]).join(', ')
  return `${days}, ${trigger.time}`
}

export const LIM = { name: 64, title: 64, description: 1000, instructions: 2000, message: 2000, agents: 50, teams: 20, members: 6, request: 2000, plannerCalls: 200 } as const

const ERR: Record<string, string> = {
  invalid_agent: 'Check the fields. Something is empty or too long.', invalid_team: 'Check the fields. Something is empty or too long.',
  limit_reached: 'Limit reached: 50 agents or 20 teams. Archive one to make room.', unknown_member: "A member doesn't exist or is archived. Remove it and try again.",
  archived: "Archived items can't be edited.", capability_unavailable: "That capability isn't available yet.", agent_unavailable: 'This agent or team is archived or no longer exists.',
  team_member_unavailable: 'A team member is archived. Replace them before starting.', invalid_start: 'Describe the task before starting.',
  invalid_schedule: 'Check the schedule. A field is missing or out of range.',
  invalid_room: 'This team room no longer exists.', invalid_message: 'Write a message of up to 2000 characters.',
  agent_profile_revocation_failed: 'Profile access is off, but an active task could not be stopped. Check the task before enabling this profile again.',
  usage_unavailable: 'Usage tracking is not available in this window.', invalid_limit: 'A limit must be a positive number, or blank for no limit.',
  memory_unavailable: 'Memory is not available in this window.', invalid_memory_entry: 'Write a memory of up to 4 KB.', memory_limit: 'Memory is full: 100 entries. Delete one to make room.',
  routine_deleted: 'This routine was deleted.', origin_not_allowed: 'Every step must stay on the routine’s sites.', definition_too_large: 'This routine is too large. Remove some steps.',
}
export const errorCopy = (code: string) => ERR[code]
/**
 * Electron's invoke drops an error's `code`; only its message crosses, prefixed
 * with the channel. The host puts the code in that message as "[code] ...".
 * Show a known code's copy, else the host's own message.
 */
export function errText(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const rest = message.replace(/^Error invoking remote method '[^']*': /, '').replace(/^\w*Error: /, '')
  const tagged = /^\[([a-z][a-z0-9_]*)\] /.exec(rest)
  const own = (error as { code?: unknown } | null)?.code
  const code = typeof own === 'string' ? own : tagged?.[1]
  if (code && ERR[code]) return ERR[code]
  const stripped = (tagged ? rest.slice(tagged[0].length) : rest).trim()
  return stripped || 'Something went wrong. Try again.'
}
