export type Usage4 = {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  usdIn: number
  usdCw: number
  usdCr: number
  usdOut: number
  usd: number
  /** What the same tokens would have cost with no prompt cache at all. */
  uncachedUsd: number
  requests: number
}

export type AgentKind = 'main' | 'subagent' | 'workflow' | 'engine'

export type AgentRow = Usage4 & {
  id: string
  kind: AgentKind
  label: string
  type: string
  parentId?: string
  model: string
  /** The effort of the agent's last request (`xhigh`, `low`, a budget); '' when the model has none. */
  effort?: string
  status: 'running' | 'done'
  startedAt: number
  lastAt: number
}

export type TaskRow = Usage4 & {
  turnId: string
  prompt: string
  startedAt: number
  endedAt?: number
  agents: number
  /** The main loop's model and effort on the task's last request. */
  model?: string
  effort?: string
}

export type SkillRow = Usage4 & {
  skill: string
  calls: number
  injectedTokens: number
}

export type ModelRow = Usage4 & {
  model: string
  /** The same spend split by effort level. */
  efforts?: Record<string, Usage4>
}

/** What the main loop runs on now. */
export type Now = { model: string; effort: string; at: number }

export type Peak = { usd: number; who: string; model: string; at: number }

export type Ledger = {
  startedAt: number
  totals: Usage4
  agents: Record<string, AgentRow>
  tasks: TaskRow[]
  skills: Record<string, SkillRow>
  models: Record<string, ModelRow>
  spark: number[]
  peak: Peak | null
  milestone: number
  /** The part of `totals.usd` already written to the cross-session history. */
  persistedUsd: number
  persistedTokens: number
  now?: Now
}

export type Track = {
  mainTurn: string | null
  skillLoop: string | null
  rootTurnOf: Record<string, string>
  activeSkill: Record<string, string>
  latestWorkflow: string | null
}

export type Tab = 'overview' | 'agents' | 'tasks' | 'skills' | 'models' | 'plan' | 'cache'

/** One loop's prompt cache as the last request that touched it left it. */
export type CacheWarm = {
  model: string
  /** When the touching request started: the TTL counts from there. */
  touchedAt: number
  expiresAt: number
  /** The cached prefix: that request's cache read + cache write tokens. */
  tokens: number
  warned: boolean
  expiredNoticed: boolean
}

export type CacheState = {
  ttl: '5m' | '1h'
  ttlSource: 'default' | 'detected' | 'set'
  /** on: hold model switches while warm; warn: only say so; off: nothing. */
  lock: 'on' | 'warn' | 'off'
  main: CacheWarm | null
  /** Latest cache per agent loop (`main`, a subagent's id); grouped by model when drawn. */
  loops?: Record<string, CacheWarm>
  busy: boolean
  bypassOnce: boolean
  /** A /model switch held until the main cache cools; runs then. */
  queued: string | null
  pinnedTurn: string | null
  pinnedFrom: string | null
  holds: number
  heldSavedUsd: number
  coldStarts: number
  coldUsd: number
}

export type RateGauge = { kind: string; percentUsed: number; resetsAt?: string }

export type View = {
  tab: Tab
  band: boolean
  plan: string
  engineUsd: number | null
  gauges: RateGauge[]
  monthUsd: number
  todayUsd: number
  allTimeUsd: number
  /** The live context window, as the status line has it. */
  context?: { tokens?: number; window: number; percent?: number }
  /** The highest context-fill alert already shown (80, 90). */
  ctxWarned?: number
}

declare module 'claude-code' {
  interface PluginState {
    tokenscope: { ledger: Ledger; track: Track; view: View; cache: CacheState }
  }
}
