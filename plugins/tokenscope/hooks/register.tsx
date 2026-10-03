import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import type { AgentRow, CacheState, CacheWarm, Ledger, RateGauge, Tab, TaskRow, Track, Usage4, View } from '../types'
import {
  C,
  type Kit,
  ctxColor,
  effortColor,
  effortLabel,
  familyColor,
  lpad,
  modelKey,
  modelName,
  pad,
  pct,
} from './kit'
import { ByModel, CacheGroups, ModelCards, ModelStrip, NowLine, buildGroups } from './models'
import {
  freshCache,
  isWarm,
  keepWarmUsd,
  keepsModel,
  mmss,
  sameModel,
  switchUsd,
  targetModel,
  ttlMs,
  warmColor,
} from './cache'
import {
  EMPTY,
  PLANS,
  add,
  bar,
  fmtDuration,
  fmtTok,
  fmtUsd,
  heat,
  hitRate,
  price,
  rateFor,
  shortModel,
  sparkline,
  split,
  tokens,
} from './pricing'

const PANE = 'tokenscope'


const MILESTONES = [0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]

const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['agents', 'Agents'],
  ['tasks', 'Tasks'],
  ['skills', 'Skills'],
  ['models', 'Models'],
  ['plan', 'Plan'],
  ['cache', 'Cache'],
]

type Days = Record<string, { usd: number; tokens: number }>

const mainRow = (now: number): AgentRow => ({
  ...EMPTY,
  id: 'main',
  kind: 'main',
  label: 'main thread',
  type: 'main',
  model: '',
  status: 'running',
  startedAt: now,
  lastAt: now,
})

const freshLedger = (now: number): Ledger => ({
  startedAt: now,
  totals: { ...EMPTY },
  agents: { main: mainRow(now) },
  tasks: [],
  skills: {},
  models: {},
  spark: [],
  peak: null,
  milestone: 0,
  persistedUsd: 0,
  persistedTokens: 0,
})

const freshTrack = (): Track => ({
  mainTurn: null,
  skillLoop: null,
  rootTurnOf: {},
  activeSkill: {},
  latestWorkflow: null,
})

const ledger = atom({ plugin: 'tokenscope', key: 'ledger' } as const, freshLedger(0))
const track = atom({ plugin: 'tokenscope', key: 'track' } as const, freshTrack())
const view = atom({ plugin: 'tokenscope', key: 'view' } as const, {
  tab: 'overview',
  band: true,
  plan: '',
  engineUsd: null,
  gauges: [],
  monthUsd: 0,
  todayUsd: 0,
  allTimeUsd: 0,
} as View)
const cache = atom({ plugin: 'tokenscope', key: 'cache' } as const, freshCache())

// ── text helpers ────────────────────────────────────────────────────────────

const two = (n: number) => String(n).padStart(2, '0')

function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

function untilText(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  return Number.isNaN(at) ? '' : `resets in ${fmtDuration(at - now)}`
}

function gaugeColor(p: number): string {
  return p < 50 ? C.cr : p < 80 ? C.usd : '#f43f5e'
}

function gaugeName(kind: string): string {
  return kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : kind.replace(/_/g, ' ')
}

// ── recording ───────────────────────────────────────────────────────────────

function cacheBadge(c: CacheState, now: number): string {
  const m = c.main
  if (!m) return ''
  const lock = c.lock === 'on' ? ' 🔒' : ''
  return isWarm(m, now) ? ` · ⏱ ${mmss(m.expiresAt - now)}${lock}` : ' · ❄ cold'
}

async function setStatus($: EngineInterface, l?: Ledger) {
  const led = l ?? (await read($, ledger))
  if (led.totals.requests === 0 && !led.now) return
  const c = await read($, cache)
  const v = await read($, view)
  const now = await $.clock.now()
  const n = led.now
  const head = n ? `◆ ${modelName(n.model)}${n.effort ? '·' + n.effort : ''}` : '◆'
  const ctx = v.context?.percent !== undefined ? ` · ctx ${v.context.percent}%` : ''
  $.ui.status(`${head}${cacheBadge(c, now)} · ${fmtUsd(led.totals.usd)}${ctx} · hit ${pct(hitRate(led.totals))}`)
}

/** Notes the cache a request touched; times the TTL from the request's start. */
async function recordCache(
  $: EngineInterface,
  agentId: string | undefined,
  startedAt: number,
  model: string,
  usage: ModelUsage,
) {
  const read_ = usage.cache_read_input_tokens
  const touched = read_ + usage.cache_creation_input_tokens
  if (touched === 0) return
  let note = ''
  await update($, cache, c => {
    const warmFor = (ttl: CacheState['ttl']): CacheWarm => ({
      model,
      touchedAt: startedAt,
      expiresAt: startedAt + ttlMs(ttl),
      tokens: touched,
      warned: false,
      expiredNoticed: false,
    })
    const loops: Record<string, CacheWarm> = {}
    for (const [id, w] of Object.entries(c.loops ?? {})) {
      if (startedAt - w.expiresAt < 15 * 60_000) loops[id] = w
    }
    loops[agentId ?? 'main'] = warmFor(c.ttl)
    if (agentId) return { ...c, loops }
    const prev = c.main
    let next: CacheState = { ...c, loops, main: warmFor(c.ttl) }
    note = ''
    if (prev && sameModel(prev.model, model)) {
      const reread = read_ >= prev.tokens * 0.8
      const gap = startedAt - prev.touchedAt
      if (startedAt >= prev.expiresAt && reread && c.ttl === '5m' && c.ttlSource !== 'set') {
        next = { ...next, ttl: '1h', ttlSource: 'detected', main: warmFor('1h'), loops: { ...loops, main: warmFor('1h') } }
        note = 'Cache survived past 5 minutes: TokenScope now times a 1-hour TTL.'
      } else if (startedAt >= prev.expiresAt && !reread) {
        const r = rateFor(model)
        next = {
          ...next,
          coldStarts: c.coldStarts + 1,
          coldUsd: c.coldUsd + (Math.min(prev.tokens, touched) * (r.input * 1.25 - r.cacheRead)) / 1e6,
        }
      } else if (c.ttl === '1h' && c.ttlSource === 'detected' && gap > 300_000 && read_ === 0) {
        next = { ...next, ttl: '5m', ttlSource: 'detected', main: warmFor('5m'), loops: { ...loops, main: warmFor('5m') } }
        note = 'Cache cooled after 5 minutes: TokenScope now times a 5-minute TTL.'
      }
    }
    return next
  })
  if (note) $.ui.toast(`⏱ ${note}`, { timeoutMs: 6000 })
}

async function runQueued($: EngineInterface) {
  const c = await read($, cache)
  const target = c.queued
  if (!target) return
  await update($, cache, x => ({ ...x, queued: null }))
  $.ui.toast(`🔁 Cache cooled: switching to ${target} as you asked`, { timeoutMs: 6000 })
  await $.command.run({ command: 'model', args: target })
}

/** Once a second: redraw the countdown, warn before expiry, run a queued switch. */
async function tick($: EngineInterface) {
  const c = await read($, cache)
  const now = await $.clock.now()
  const m = c.main
  const anyWarm = Object.values(c.loops ?? {}).some(w => isWarm(w, now))
  if (anyWarm && (!m || m.expiresAt <= now)) $.ui.invalidate('ui.render')
  if (!m) return
  const left = m.expiresAt - now
  if (left > 0) {
    $.ui.invalidate('ui.render')
    await setStatus($)
    if (left <= 60_000 && !m.warned && !c.busy) {
      await update($, cache, x => (x.main ? { ...x, main: { ...x.main, warned: true } } : x))
      $.ui.toast(
        `⏱ ${shortModel(m.model)} cache expires in ${mmss(left)}: prompt now to keep ${fmtTok(m.tokens)} tokens warm (worth ${fmtUsd(keepWarmUsd(m))})`,
        { timeoutMs: 8000 },
      )
    }
    return
  }
  if (m.expiredNoticed) return
  await update($, cache, x => (x.main ? { ...x, main: { ...x.main, expiredNoticed: true } } : x))
  $.ui.invalidate('ui.render')
  await setStatus($)
  if (c.queued && !c.busy) {
    await runQueued($)
  } else {
    $.ui.toast(
      `❄ ${shortModel(m.model)} cache expired: the next request re-writes ~${fmtTok(m.tokens)} tokens (+${fmtUsd(keepWarmUsd(m))}). Model switches are free now.`,
      { timeoutMs: 8000 },
    )
  }
}

/**
 * The model a main-loop request should keep while the cache is warm: a switch
 * the picker let through is held to the cached model for that whole turn.
 * Mid-turn changes the engine makes (a refusal's fallback) pass untouched.
 */
async function pinFor($: EngineInterface, model: string, turnId: string, index: number, now: number) {
  const c = await read($, cache)
  const m = c.main
  if (c.pinnedTurn === turnId) return c.pinnedFrom && sameModel(model, c.pinnedFrom) ? m?.model : undefined
  if (index !== 0 || c.lock === 'off' || !m || !isWarm(m, now) || sameModel(model, m.model)) return undefined
  if (c.bypassOnce) {
    await update($, cache, x => ({ ...x, bypassOnce: false }))
    return undefined
  }
  const cost = switchUsd(m, model)
  if (c.lock === 'warn') {
    $.ui.toast(
      `⚠ Switching ${shortModel(m.model)} → ${shortModel(model)} with ${mmss(m.expiresAt - now)} of warm cache left: re-writes ${fmtTok(m.tokens)} tokens (~${fmtUsd(cost)})`,
      { timeoutMs: 8000 },
    )
    return undefined
  }
  await update($, cache, x => ({
    ...x,
    pinnedTurn: turnId,
    pinnedFrom: model,
    holds: x.holds + 1,
    heldSavedUsd: x.heldSavedUsd + cost,
  }))
  $.ui.toast(
    `🔒 Kept ${shortModel(m.model)} for this turn: its cache is warm for ${mmss(m.expiresAt - now)} (${fmtTok(m.tokens)} tokens). ${shortModel(model)} now would re-write them for ~${fmtUsd(cost)}. /tokenscope unlock to switch anyway.`,
    { timeoutMs: 9000 },
  )
  return m.model
}

async function record(
  $: EngineInterface,
  agentId: string | undefined,
  turnId: string,
  model: string,
  usage: ModelUsage,
  effort: string,
) {
  const now = await $.clock.now()
  const u = price(usage, model)
  const t = await read($, track)
  const loop = agentId ?? 'main'

  const l = await update($, ledger, prev => {
    const agents = { ...prev.agents }
    const known = agents[loop]
    const wf = t.latestWorkflow
    const row: AgentRow = known ?? {
      ...EMPTY,
      id: loop,
      kind: wf ? 'subagent' : 'engine',
      label: wf ? 'workflow agent' : 'background fork',
      type: wf ? 'workflow' : 'compaction · memory · side query',
      ...(wf ? { parentId: wf } : {}),
      model,
      status: 'running',
      startedAt: now,
      lastAt: now,
    }
    agents[loop] = { ...add(row, u), model, effort, lastAt: now }

    const root = agentId ? (t.rootTurnOf[agentId] ?? t.mainTurn) : turnId
    let tasks = prev.tasks
    if (!agentId && !tasks.some(k => k.turnId === turnId)) {
      tasks = [...tasks, { ...EMPTY, turnId, prompt: '(continuation)', startedAt: now, agents: 0 }]
    }
    if (root) {
      tasks = tasks.map(k =>
        k.turnId === root ? { ...add(k, u), ...(agentId ? {} : { model, effort }) } : k,
      )
    }

    const skill = t.activeSkill[loop]
    const skills = skill
      ? {
          ...prev.skills,
          [skill]: add(prev.skills[skill] ?? { ...EMPTY, skill, calls: 0, injectedTokens: 0 }, u),
        }
      : prev.skills

    const mrow = add(prev.models[model] ?? { ...EMPTY, model }, u)
    const efforts = { ...(mrow.efforts ?? {}) }
    const ek = effort || 'default'
    efforts[ek] = add(efforts[ek] ?? { ...EMPTY }, u)
    const models = { ...prev.models, [model]: { ...mrow, efforts } }
    const peak =
      !prev.peak || u.usd > prev.peak.usd ? { usd: u.usd, who: row.label, model, at: now } : prev.peak

    return {
      ...prev,
      agents,
      tasks: tasks.slice(-200),
      skills,
      models,
      totals: add(prev.totals, u),
      spark: [...prev.spark, u.usd].slice(-240),
      peak,
      ...(agentId ? {} : { now: { model, effort, at: now } }),
    }
  })

  const crossed = MILESTONES.filter(m => m > l.milestone && l.totals.usd >= m).pop()
  if (crossed !== undefined) {
    await update($, ledger, x => ({ ...x, milestone: Math.max(x.milestone, crossed) }))
    $.ui.toast(`💸 TokenScope: this session just crossed ${fmtUsd(crossed)} (API-equivalent)`, {
      timeoutMs: 6000,
    })
  }
  await setStatus($, l)
}

async function loadHistory($: EngineInterface) {
  const days = ((await $.store.get('days')) ?? {}) as Days
  const today = dayKey(await $.clock.now())
  const month = today.slice(0, 7)
  let monthUsd = 0
  let allTimeUsd = 0
  for (const [day, v] of Object.entries(days)) {
    allTimeUsd += v.usd
    if (day.startsWith(month)) monthUsd += v.usd
  }
  const todayUsd = days[today]?.usd ?? 0
  const plan = String((await $.store.get('plan')) ?? '')
  await update($, view, v => ({ ...v, monthUsd, todayUsd, allTimeUsd, plan }))
}

async function persist($: EngineInterface) {
  const l = await read($, ledger)
  const dUsd = l.totals.usd - l.persistedUsd
  const dTok = tokens(l.totals) - l.persistedTokens
  if (dUsd <= 0 && dTok <= 0) return
  const days = ((await $.store.get('days')) ?? {}) as Days
  const key = dayKey(await $.clock.now())
  const day = days[key] ?? { usd: 0, tokens: 0 }
  days[key] = { usd: day.usd + dUsd, tokens: day.tokens + dTok }
  await $.store.set('days', days)
  await update($, ledger, x => ({
    ...x,
    persistedUsd: x.persistedUsd + dUsd,
    persistedTokens: x.persistedTokens + dTok,
  }))
  await loadHistory($)
}

async function setGauges($: EngineInterface, gauges: readonly RateGauge[], usd: number | undefined) {
  await update($, view, v => ({
    ...v,
    gauges: gauges.map(g => ({ kind: g.kind, percentUsed: g.percentUsed, ...(g.resetsAt ? { resetsAt: g.resetsAt } : {}) })),
    engineUsd: usd ?? v.engineUsd,
  }))
}

/** Keeps the live context window and warns as it fills: every request re-reads it. */
async function setContext($: EngineInterface, ctx: { tokens?: number; window: number; percent?: number } | undefined) {
  if (!ctx) return
  const context = {
    window: ctx.window,
    ...(ctx.tokens !== undefined ? { tokens: ctx.tokens } : {}),
    ...(ctx.percent !== undefined ? { percent: ctx.percent } : {}),
  }
  const p = ctx.percent ?? 0
  const level = p >= 90 ? 90 : p >= 80 ? 80 : 0
  const v = await update($, view, x => ({ ...x, context, ctxWarned: level < (x.ctxWarned ?? 0) ? level : (x.ctxWarned ?? 0) }))
  if (level > 0 && level > (v.ctxWarned ?? 0)) {
    await update($, view, x => ({ ...x, ctxWarned: level }))
    const l = await read($, ledger)
    const model = l.now?.model ?? ''
    const r = rateFor(model)
    const t = ctx.tokens ?? 0
    $.ui.toast(
      `🧠 Context ${p}% full (${fmtTok(t)} of ${fmtTok(ctx.window)}): each request re-reads it, ${fmtUsd((t * r.cacheRead) / 1e6)} warm · ${fmtUsd((t * r.input * 1.25) / 1e6)} cold. /compact soon.`,
      { timeoutMs: 9000 },
    )
  }
}

/** The main loop's model as /model shows it, for the Now line before the next request. */
async function refreshModel($: EngineInterface) {
  const model = await $.session.model().catch(() => '')
  if (!/(fable|mythos|opus|sonnet|haiku)/i.test(model)) return
  const now = await $.clock.now()
  await update($, ledger, l =>
    l.now && sameModel(l.now.model, model) ? l : { ...l, now: { model, effort: l.now?.effort ?? '', at: now } },
  )
  await setStatus($)
}

function workflowName(e: Record<string, unknown>): string {
  if (typeof e.name === 'string' && e.name) return e.name
  const script = typeof e.script === 'string' ? e.script : ''
  const m = script.match(/name:\s*['"`]([^'"`]+)['"`]/)
  if (m?.[1]) return m[1]
  const path = typeof e.scriptPath === 'string' ? e.scriptPath : ''
  return path.split('/').pop()?.replace(/\.\w+$/, '') || 'workflow'
}

// ── receipt ─────────────────────────────────────────────────────────────────

function receipt(l: Ledger, v: View, now: number): string {
  const W = 44
  const line = (left: string, right: string) => pad(left, W - right.length - 1) + ' ' + right
  const center = (s: string) => ' '.repeat(Math.max(0, Math.floor((W - s.length) / 2))) + s
  const rule = '-'.repeat(W)
  const d = new Date(now)
  const out = [
    center('◆  T O K E N S C O P E  ◆'),
    center('API-equivalent receipt'),
    center(`${dayKey(now)} ${two(d.getHours())}:${two(d.getMinutes())} · session ${fmtDuration(now - l.startedAt)}`),
    rule,
  ]
  const agents = Object.values(l.agents)
    .filter(a => a.requests > 0)
    .sort((a, b) => b.usd - a.usd)
  for (const a of agents.slice(0, 12)) {
    const name = a.kind === 'main' ? 'MAIN THREAD' : `${a.type} · ${a.label}`
    out.push(line(` ${name}`, fmtUsd(a.usd)))
  }
  if (agents.length > 12) {
    out.push(line(` …${agents.length - 12} more`, fmtUsd(agents.slice(12).reduce((s, a) => s + a.usd, 0))))
  }
  const models = Object.values(l.models).sort((a, b) => b.usd - a.usd)
  if (models.length) {
    out.push(rule)
    for (const m of models) {
      const efforts = Object.keys(m.efforts ?? {}).filter(k => k !== 'default').join('/')
      out.push(line(` ${shortModel(m.model)}${efforts ? ' · ' + efforts : ''}  ${m.requests} req`, fmtUsd(m.usd)))
    }
  }
  const skills = Object.values(l.skills)
  if (skills.length) {
    out.push(rule)
    for (const s of skills) out.push(line(` skill /${s.skill} ×${s.calls}`, fmtUsd(s.usd)))
  }
  const t = l.totals
  out.push(
    rule,
    line(` Input        ${lpad(fmtTok(t.input), 7)}`, fmtUsd(t.usdIn)),
    line(` Cache write  ${lpad(fmtTok(t.cacheWrite), 7)}`, fmtUsd(t.usdCw)),
    line(` Cache read   ${lpad(fmtTok(t.cacheRead), 7)}`, fmtUsd(t.usdCr)),
    line(` Output       ${lpad(fmtTok(t.output), 7)}`, fmtUsd(t.usdOut)),
    rule,
    line(' TOTAL', fmtUsd(t.usd)),
    line(' Without prompt caching', fmtUsd(t.uncachedUsd)),
    line(' Caching saved you', fmtUsd(t.uncachedUsd - t.usd)),
  )
  if (v.engineUsd !== null) out.push(line(' Claude Code /cost ledger', fmtUsd(v.engineUsd)))
  const plan = PLANS[v.plan]
  if (plan && plan.monthly > 0) {
    const month = v.monthUsd + (t.usd - l.persistedUsd)
    out.push(rule, line(` ${plan.label} plan`, `${fmtUsd(plan.monthly)}/mo`))
    out.push(line(' Value used this month', fmtUsd(month)))
    out.push(line(' Plan leverage', `${(month / plan.monthly).toFixed(1)}x`))
  }
  out.push(rule, center('THANK YOU FOR THINKING WITH US'), center('|| ||| | |||| || | ||| || |||| | ||'))
  return '```\n' + out.join('\n') + '\n```'
}

// ── drawing ─────────────────────────────────────────────────────────────────

function MixBar(ui: Kit, label: string, parts: number[], width: number) {
  const { Box, Text } = ui
  const colors = [C.in, C.cw, C.cr, C.out]
  const cells = split(parts, Math.max(4, width - 10))
  return (
    <Box flexDirection="row">
      <Text color={C.dim}>{pad(label, 10)}</Text>
      {cells.map((n, i) => (n > 0 ? <Text color={colors[i]}>{'█'.repeat(n)}</Text> : null))}
    </Box>
  )
}

function Tile(ui: Kit, title: string, color: string, big: string, sub: string, foot: string, width: number) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={width}>
      <Text color={color} bold>
        {title}
      </Text>
      <Text bold color={C.text}>
        {big}
      </Text>
      <Text color={color}>{sub}</Text>
      <Text color={C.dim}>{foot}</Text>
    </Box>
  )
}

function insight(l: Ledger): string {
  const t = l.totals
  if (t.requests < 3) return 'Gathering signal… a few more requests and the patterns show up here.'
  const hit = hitRate(t)
  const outShare = t.usd ? t.usdOut / t.usd : 0
  const cwShare = t.usd ? t.usdCw / t.usd : 0
  const pricey = Object.values(l.agents).find(
    a => a.kind === 'subagent' && /explore/i.test(a.type) && rateFor(a.model).output >= 20,
  )
  if (pricey) return `Explore agents run on ${shortModel(pricey.model)}; Haiku 4.5 would read the same files for a fraction.`
  const eager = Object.values(l.agents).find(
    a => a.kind === 'subagent' && /explore/i.test(a.type) && ['high', 'xhigh', 'max'].includes(a.effort ?? ''),
  )
  if (eager) return `Explore agents run at ${eager.effort} effort; searching rarely needs more than low.`
  let maxUsd = 0
  for (const m of Object.values(l.models)) maxUsd += m.efforts?.max?.usd ?? 0
  if (t.usd && maxUsd / t.usd > 0.4) return `max effort is ${pct(maxUsd / t.usd)} of spend; xhigh is usually as good for coding at less output.`
  if (hit < 0.5) return `Cache hit is ${pct(hit)}. Gaps over 5 minutes between requests let the prompt cache expire.`
  if (cwShare > 0.4) return `Cache writes are ${pct(cwShare)} of spend: context keeps changing early in the prompt, or sessions are short.`
  if (outShare > 0.5) return `Output is ${pct(outShare)} of spend. Lower effort on routine subagents trims thinking tokens.`
  const x = t.usd ? t.uncachedUsd / t.usd : 1
  return `Prompt caching makes this session ${x.toFixed(1)}x cheaper than sending everything fresh.`
}

function Overview(ui: Kit, l: Ledger, W: number, byModel: ReturnType<typeof ByModel>) {
  const { Box, Text } = ui
  const t = l.totals
  const all = tokens(t) || 1
  const perRow = W >= 100 ? 6 : W >= 60 ? 3 : 2
  const tw = Math.floor((W - (perRow - 1)) / perRow)
  const saved = t.uncachedUsd - t.usd
  const top = Object.values(l.agents)
    .filter(a => a.usd > 0)
    .sort((a, b) => b.usd - a.usd)
    .slice(0, 3)
  const medals = ['🥇', '🥈', '🥉']
  const spark = sparkline(l.spark, Math.max(8, W - 22))
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {Tile(ui, 'INPUT', C.in, fmtTok(t.input), fmtUsd(t.usdIn), `${pct(t.input / all)} of tokens`, tw)}
        {Tile(ui, 'CACHE WRITE', C.cw, fmtTok(t.cacheWrite), fmtUsd(t.usdCw), `${pct(t.cacheWrite / all)} of tokens`, tw)}
        {Tile(ui, 'CACHE READ', C.cr, fmtTok(t.cacheRead), fmtUsd(t.usdCr), `${pct(t.cacheRead / all)} of tokens`, tw)}
        {Tile(ui, 'OUTPUT', C.out, fmtTok(t.output), fmtUsd(t.usdOut), `${pct(t.output / all)} of tokens`, tw)}
        {Tile(ui, 'TOTAL', C.usd, fmtUsd(t.usd), `${fmtTok(tokens(t))} tokens`, `${fmtUsd(t.requests ? t.usd / t.requests : 0)}/request`, tw)}
        {Tile(ui, 'CACHE SAVED', C.save, fmtUsd(saved), `${pct(t.uncachedUsd ? saved / t.uncachedUsd : 0)} cheaper`, `hit rate ${pct(hitRate(t))}`, tw)}
      </Box>
      <Box flexDirection="column">
        {MixBar(ui, 'tokens', [t.input, t.cacheWrite, t.cacheRead, t.output], W)}
        {MixBar(ui, 'dollars', [t.usdIn, t.usdCw, t.usdCr, t.usdOut], W)}
        <Box flexDirection="row" gap={2}>
          <Text color={C.dim}>{pad('', 8)}</Text>
          <Text color={C.in}>■ input</Text>
          <Text color={C.cw}>■ cache write</Text>
          <Text color={C.cr}>■ cache read</Text>
          <Text color={C.out}>■ output</Text>
        </Box>
      </Box>
      {byModel}
      {spark !== '' && (
        <Box flexDirection="row">
          <Text color={C.dim}>{pad('$/request', 10)}</Text>
          <Text color={C.usd}>{spark}</Text>
          <Text color={C.dim}> max {fmtUsd(Math.max(...l.spark.slice(-(W - 22))))}</Text>
        </Box>
      )}
      {l.peak && (
        <Text color={C.dim}>
          ⚡ priciest request <Text color={heat(l.peak.usd)}>{fmtUsd(l.peak.usd)}</Text> · {l.peak.who} ·{' '}
          {shortModel(l.peak.model)}
        </Text>
      )}
      {top.length > 0 && (
        <Box flexDirection="column">
          <Text bold color={C.brand}>
            Top spenders
          </Text>
          {top.map((a, i) => (
            <Box flexDirection="row" gap={1}>
              <Text>{medals[i]}</Text>
              <Text color={C.text}>{pad(a.kind === 'main' ? 'main thread' : `${a.type} · ${a.label}`, Math.max(10, W - 34))}</Text>
              <Text color={heat(a.usd)}>{lpad(fmtUsd(a.usd), 8)}</Text>
              <Text color={heat(a.usd)}>{bar(a.usd / (top[0]?.usd || 1), 14)}</Text>
            </Box>
          ))}
        </Box>
      )}
      <Box borderStyle="round" borderColor={C.brand} paddingX={1}>
        <Text color={C.text}>💡 {insight(l)}</Text>
      </Box>
    </Box>
  )
}

/** One table row: a name, an optional detail, the four token counts, dollars and a bar. */
function UsageRow(ui: Kit, name: string, nameColor: string, detail: string, u: Usage4, max: number, W: number, bold = false) {
  const { Box, Text } = ui
  const wide = W >= 96
  const fixed = wide ? 7 * 4 + 4 + 9 + 12 + 16 : 8 + 9 + 10 + 13
  const nameW = Math.max(8, W - fixed - 1)
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={nameColor} bold={bold}>
        {pad(name, nameW)}
      </Text>
      <Text color={C.dim}>{pad(detail, wide ? 15 : 12)}</Text>
      {wide ? (
        <Box flexDirection="row" gap={1}>
          <Text color={C.in}>{lpad(fmtTok(u.input), 6)}</Text>
          <Text color={C.cw}>{lpad(fmtTok(u.cacheWrite), 6)}</Text>
          <Text color={C.cr}>{lpad(fmtTok(u.cacheRead), 6)}</Text>
          <Text color={C.out}>{lpad(fmtTok(u.output), 6)}</Text>
        </Box>
      ) : (
        <Text color={C.text}>{lpad(fmtTok(tokens(u)), 7)}</Text>
      )}
      <Text color={heat(u.usd)} bold>
        {lpad(fmtUsd(u.usd), 8)}
      </Text>
      <Text color={heat(u.usd)}>{bar(max ? u.usd / max : 0, wide ? 11 : 9)}</Text>
    </Box>
  )
}

function HeaderRow(ui: Kit, first: string, detail: string, W: number) {
  const { Box, Text } = ui
  const wide = W >= 96
  const fixed = wide ? 7 * 4 + 4 + 9 + 12 + 16 : 8 + 9 + 10 + 13
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={C.dim}>{pad(first, Math.max(8, W - fixed - 1))}</Text>
      <Text color={C.dim}>{pad(detail, wide ? 15 : 12)}</Text>
      {wide ? (
        <Box flexDirection="row" gap={1}>
          <Text color={C.in}>{lpad('input', 6)}</Text>
          <Text color={C.cw}>{lpad('c.wrt', 6)}</Text>
          <Text color={C.cr}>{lpad('c.read', 6)}</Text>
          <Text color={C.out}>{lpad('output', 6)}</Text>
        </Box>
      ) : (
        <Text color={C.dim}>{lpad('tokens', 7)}</Text>
      )}
      <Text color={C.usd}>{lpad('USD', 8)}</Text>
    </Box>
  )
}

function Agents(ui: Kit, l: Ledger, W: number, now: number) {
  const { Box, Text } = ui
  const rows = Object.values(l.agents)
  const kids: Record<string, AgentRow[]> = {}
  for (const a of rows) {
    if (a.kind === 'main') continue
    const parent = a.parentId ?? (a.kind === 'subagent' ? 'main' : '')
    ;(kids[parent] ??= []).push(a)
  }
  const subtotal = (a: AgentRow): Usage4 => (kids[a.id] ?? []).reduce((s, k) => add(s, subtotal(k)), { ...EMPTY, ...a })
  const ordered: { a: AgentRow; depth: number }[] = []
  const walk = (a: AgentRow, depth: number) => {
    ordered.push({ a, depth })
    for (const k of (kids[a.id] ?? []).sort((x, y) => x.startedAt - y.startedAt)) walk(k, depth + 1)
  }
  const main = l.agents.main ?? mainRow(l.startedAt)
  walk(main, 0)
  for (const a of rows.filter(r => r.kind === 'workflow')) walk(a, 0)
  for (const a of rows.filter(r => r.kind === 'engine' && !r.parentId)) walk(a, 0)
  const max = Math.max(...ordered.map(o => subtotal(o.a).usd), 0)
  const glyph = (a: AgentRow) =>
    a.kind === 'main' ? '◆' : a.kind === 'workflow' ? '⚙' : a.kind === 'engine' ? '⟳' : a.status === 'done' ? '✓' : '◐'
  const color = (a: AgentRow) =>
    a.kind === 'main' ? C.brand : a.kind === 'workflow' ? C.cw : a.kind === 'engine' ? C.dim : a.status === 'done' ? C.cr : C.in
  const subagents = rows.filter(r => r.kind === 'subagent').length
  return (
    <Box flexDirection="column">
      <Text color={C.dim}>
        {subagents} subagent{subagents === 1 ? '' : 's'} · ◆ main ◐ running ✓ done ⚙ workflow ⟳ engine fork · rows include
        their children
      </Text>
      {HeaderRow(ui, 'agent', 'model · effort', W)}
      {ordered.map(({ a, depth }) => {
        const name = `${'  '.repeat(depth)}${glyph(a)} ${a.kind === 'main' || a.kind === 'workflow' ? a.label : `${a.type} · ${a.label}`}`
        const age = a.kind === 'subagent' && a.status === 'running' ? fmtDuration(now - a.startedAt) : ''
        const tag = a.model ? `${shortModel(a.model)}${a.effort ? '·' + a.effort : ''}` : age
        return UsageRow(ui, name, color(a), tag, subtotal(a), max, W, depth === 0)
      })}
    </Box>
  )
}

function Tasks(ui: Kit, l: Ledger, W: number, now: number, room: number) {
  const { Box, Text } = ui
  const list: TaskRow[] = l.tasks.slice().reverse().slice(0, Math.max(3, room))
  if (list.length === 0) return <Text color={C.dim}>No tasks yet: every prompt you send becomes a task here, subagents included.</Text>
  const max = Math.max(...list.map(t => t.usd), 0)
  const n = l.tasks.length
  return (
    <Box flexDirection="column">
      {HeaderRow(ui, 'task (prompt)', 'time · req', W)}
      {list.map((t, i) => {
        const time = fmtDuration((t.endedAt ?? now) - t.startedAt)
        const tag = t.model ? `[${shortModel(t.model).split(' ')[0]}${t.effort ? '·' + t.effort : ''}] ` : ''
        const name = `${t.endedAt ? '✓' : '◐'} #${n - i} ${tag}${t.prompt.replace(/\s+/g, ' ') || '(no text)'}`
        const detail = `${time} · ${t.requests}${t.agents ? ` · ${t.agents}a` : ''}`
        return UsageRow(ui, name, t.endedAt ? C.text : C.in, detail, t, max, W)
      })}
    </Box>
  )
}

function Skills(ui: Kit, l: Ledger, W: number) {
  const { Box, Text } = ui
  const list = Object.values(l.skills).sort((a, b) => b.usd - a.usd)
  const max = Math.max(...list.map(s => s.usd), 0)
  return (
    <Box flexDirection="column">
      {list.length === 0 ? (
        <Text color={C.dim}>No skills invoked yet. A skill used through /name or the Skill tool shows here.</Text>
      ) : (
        <Box flexDirection="column">
          {HeaderRow(ui, 'skill', 'calls · inj', W)}
          {list.map(s =>
            UsageRow(ui, `/${s.skill}`, C.brand, `×${s.calls} · ~${fmtTok(s.injectedTokens)}`, s, max, W),
          )}
        </Box>
      )}
      <Text color={C.dim}>
        inj = the skill's own prompt, estimated in tokens. Dollars = every request made in that agent loop while the
        skill was active, until its turn ended.
      </Text>
    </Box>
  )
}

function Plan($: EngineInterface, ui: Kit, l: Ledger, v: View, W: number, now: number) {
  const { Box, Text, Button } = ui
  const live = l.totals.usd - l.persistedUsd
  const today = v.todayUsd + live
  const month = v.monthUsd + live
  const allTime = v.allTimeUsd + live
  const plan = PLANS[v.plan]
  const dayOfMonth = new Date(now).getDate()
  const choose = (id: string) => async () => {
    await $.store.set('plan', id)
    await update($, view, x => ({ ...x, plan: id }))
  }
  const leverage = plan && plan.monthly > 0 ? month / plan.monthly : 0
  const gw = Math.max(10, W - 40)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Text color={C.dim}>your plan:</Text>
        {(['pro', 'max5', 'max20', 'api'] as const).map((id, i) => (
          <Button
            key={`plan-${id}`}
            label={PLANS[id]?.label ?? id}
            hotkey={['p', 'm', 'x', 'a'][i]}
            variant={v.plan === id ? 'primary' : 'secondary'}
            onPress={choose(id)}
          />
        ))}
      </Box>
      <Box flexDirection="column">
        {[
          ['This session', l.totals.usd],
          ['Today', today],
          ['This month', month],
          ['All time (tracked)', allTime],
        ].map(([label, usd]) => (
          <Box flexDirection="row" gap={1}>
            <Text color={C.text}>{pad(String(label), 20)}</Text>
            <Text color={heat(Number(usd))} bold>
              {lpad(fmtUsd(Number(usd)), 10)}
            </Text>
          </Box>
        ))}
      </Box>
      {plan && plan.monthly > 0 ? (
        <Box flexDirection="column" borderStyle="round" borderColor={leverage >= 1 ? C.cr : C.usd} paddingX={1}>
          <Text bold color={leverage >= 1 ? C.cr : C.usd}>
            {leverage >= 1 ? '🚀' : '⏳'} {leverage.toFixed(2)}x plan leverage
          </Text>
          <Text color={C.text}>
            {fmtUsd(month)} of API-equivalent work on a {fmtUsd(plan.monthly)}/mo {plan.label} plan ·{' '}
            {fmtUsd(month / Math.max(1, dayOfMonth))}/day
          </Text>
          <Text color={leverage >= 1 ? C.cr : C.usd}>{bar(Math.min(1, leverage), gw)}</Text>
          <Text color={C.dim}>
            {leverage >= 1
              ? `Paid for itself ${leverage.toFixed(1)} times over this month.`
              : `${fmtUsd(plan.monthly - month)} more API-equivalent use to break even this month.`}
          </Text>
        </Box>
      ) : plan ? (
        <Text color={C.text}>Pay-as-you-go: these dollars are what the API bills you.</Text>
      ) : (
        <Text color={C.usd}>Pick your plan above (or /tokenscope plan max20) to see what your subscription is worth.</Text>
      )}
      <Box flexDirection="column">
        <Text bold color={C.brand}>
          Rate-limit fuel
        </Text>
        {v.gauges.length === 0 ? (
          <Text color={C.dim}>No rate-limit windows reported yet (shown on subscription plans after a request).</Text>
        ) : (
          v.gauges.map(g => (
            <Box flexDirection="row" gap={1}>
              <Text color={C.text}>{pad(gaugeName(g.kind), 8)}</Text>
              <Text color={gaugeColor(g.percentUsed)}>{bar(g.percentUsed / 100, gw).padEnd(gw, '·')}</Text>
              <Text color={gaugeColor(g.percentUsed)} bold>
                {lpad(`${g.percentUsed}%`, 5)}
              </Text>
              <Text color={C.dim}>{untilText(g.resetsAt, now)}</Text>
            </Box>
          ))
        )}
      </Box>
      <Text color={C.dim}>
        Subscriptions aren't billed per token: these figures price the same tokens at Anthropic's list API rates
        (cache writes at 1.25x input, the 5-minute cache). History is kept across sessions in this mod's store.
      </Text>
    </Box>
  )
}

function CacheTab($: EngineInterface, ui: Kit, c: CacheState, W: number, now: number, groups: ReturnType<typeof buildGroups>) {
  const { Box, Text, Button } = ui
  const m = c.main
  const ttl = ttlMs(c.ttl)
  const warm = isWarm(m, now)
  const color = m && warm ? warmColor(m, now, ttl) : '#93c5fd'
  const bw = Math.max(10, W - 4)
  const setLock = (lock: CacheState['lock']) => () => update($, cache, x => ({ ...x, lock }))
  const setTtl = (t: CacheState['ttl']) => () =>
    update($, cache, x => ({
      ...x,
      ttl: t,
      ttlSource: 'set' as const,
      main: x.main ? { ...x.main, expiresAt: x.main.touchedAt + ttlMs(t) } : null,
    }))
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        {!m ? (
          <Text color={C.dim}>No prompt cache yet. It starts with the first request of this session.</Text>
        ) : (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text color={color} bold>
                {warm ? `⏱  ${mmss(m.expiresAt - now)}  until the ${shortModel(m.model)} cache expires` : `❄  ${shortModel(m.model)} cache expired`}
              </Text>
              <Text color={C.dim}>
                {warm ? `at ${new Date(m.expiresAt).toLocaleTimeString()}` : `${fmtDuration(now - m.expiresAt)} ago`}
              </Text>
            </Box>
            <Text color={color}>{bar(warm ? (m.expiresAt - now) / ttl : 0, bw).padEnd(bw, '·')}</Text>
            <Text color={C.text}>
              {fmtTok(m.tokens)} tokens cached · TTL {c.ttl} ({c.ttlSource}) · counted from the last request's start
            </Text>
            <Text color={C.dim}>
              {warm
                ? `Keep it warm: the next request reads it for ${fmtUsd((m.tokens * rateFor(m.model).cacheRead) / 1e6)} instead of re-writing it for ${fmtUsd((m.tokens * rateFor(m.model).input * 1.25) / 1e6)}.`
                : `The next request re-writes it for ~${fmtUsd((m.tokens * rateFor(m.model).input * 1.25) / 1e6)}. Switching models costs no more than staying now.`}
            </Text>
          </Box>
        )}
      </Box>
      <Box flexDirection="column">
        <Text bold color={C.brand}>
          Model lock while warm
        </Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="lock-on" label="🔒 Hold switches" hotkey="l" variant={c.lock === 'on' ? 'primary' : 'secondary'} onPress={setLock('on')} />
          <Button key="lock-warn" label="⚠ Warn only" hotkey="w" variant={c.lock === 'warn' ? 'primary' : 'secondary'} onPress={setLock('warn')} />
          <Button key="lock-off" label="Off" hotkey="o" variant={c.lock === 'off' ? 'primary' : 'secondary'} onPress={setLock('off')} />
          <Button
            key="unlock"
            label="Unlock once"
            hotkey="u"
            onPress={() => update($, cache, x => ({ ...x, bypassOnce: true, queued: null, pinnedTurn: null, pinnedFrom: null }))}
          />
        </Box>
        <Text color={C.dim}>
          Hold: /model X while warm is queued and runs by itself when the cache cools; a model picked in the menu is
          kept on the cached model for that turn. Fallbacks the engine makes mid-turn always pass.
        </Text>
        {c.bypassOnce && <Text color={C.usd}>Unlocked: the next switch goes through.</Text>}
        {c.queued && (
          <Box flexDirection="row" gap={1}>
            <Text color={C.usd}>
              🔁 queued: /model {c.queued} {warm && m ? `in ${mmss(m.expiresAt - now)}` : 'after this turn'}
            </Text>
            <Button key="cancel-queue" label="Cancel" hotkey="c" onPress={() => update($, cache, x => ({ ...x, queued: null }))} />
          </Box>
        )}
      </Box>
      <Box flexDirection="row" gap={1}>
        <Text color={C.dim}>cache TTL:</Text>
        <Button key="ttl-5m" label="5 min" hotkey="f" variant={c.ttl === '5m' ? 'primary' : 'secondary'} onPress={setTtl('5m')} />
        <Button key="ttl-1h" label="1 hour" hotkey="h" variant={c.ttl === '1h' ? 'primary' : 'secondary'} onPress={setTtl('1h')} />
        <Text color={C.dim}>({c.ttlSource === 'set' ? 'set by you' : c.ttlSource === 'detected' ? 'detected from reads' : 'default; auto-detects'})</Text>
      </Box>
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={C.text}>{pad('Switches held', 22)}</Text>
          <Text color={C.cr} bold>
            {lpad(String(c.holds), 4)}
          </Text>
          <Text color={C.dim}>re-writes avoided ≈ {fmtUsd(c.heldSavedUsd)}</Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color={C.text}>{pad('Cold starts (expired)', 22)}</Text>
          <Text color={c.coldStarts ? '#fb923c' : C.cr} bold>
            {lpad(String(c.coldStarts), 4)}
          </Text>
          <Text color={C.dim}>extra paid re-writing ≈ {fmtUsd(c.coldUsd)}</Text>
        </Box>
      </Box>
      {CacheGroups(ui, groups, c, now, W)}
    </Box>
  )
}

// ── hooks ───────────────────────────────────────────────────────────────────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // first, so a failure below never leaves the countdown without its clock
    $.clock.every(1000, () => void tick($).catch(() => undefined))
    await $.command.register({
      name: 'tokenscope',
      description: 'Token & USD observatory: per agent, task, skill, model and plan',
      argumentHint: '[band | receipt | plan <pro|max5|max20|api> | lock <on|warn|off> | unlock | ttl <5m|1h> | reset]',
    })
    const now = await $.clock.now()
    const l = await update($, ledger, x => (x.startedAt === 0 ? freshLedger(now) : x))
    await loadHistory($)
    try {
      const usage = await $.session.usage()
      await setGauges($, usage.rateLimits, usage.cost?.usd)
      await setContext($, usage.context)
      await refreshModel($)
    } catch {
      // the figures arrive with the next session.measure
    }
    await update($, cache, c => ({ ...c, busy: false }))
    await setStatus($, l)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await persist($)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, track, t => ({ ...t, mainTurn: e.turnId }))
    await update($, cache, c => ({ ...c, busy: true }))
    await update($, ledger, l => ({
      ...l,
      tasks: [
        ...l.tasks,
        { ...EMPTY, turnId: e.turnId, prompt: e.text.slice(0, 160) || '(continuation)', startedAt: now, agents: 0 },
      ].slice(-200),
    }))
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    let pinned: string | undefined
    if (!e.agentId) {
      try {
        pinned = await pinFor($, e.model, e.turnId, e.index, startedAt)
      } catch {
        pinned = undefined
      }
    }
    const effort = effortLabel(e.effort)
    if (!e.agentId) {
      const model = pinned ?? e.model
      await update($, ledger, l => ({ ...l, now: { model, effort, at: startedAt } })).catch(() => undefined)
    }
    const result = yield* next(pinned ? { ...e, model: pinned } : e)
    if (result?.usage) {
      const model = result.usage.model || pinned || e.model
      try {
        await record($, e.agentId, e.turnId, model, result.usage, effort)
        await recordCache($, e.agentId, startedAt, model, result.usage)
      } catch {
        // never let accounting disturb the turn
      }
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const now = await $.clock.now()
    const loop = e.agentId ?? 'main'
    await update($, track, t => {
      const activeSkill = { ...t.activeSkill }
      delete activeSkill[loop]
      return { ...t, activeSkill }
    })
    if (e.agentId) {
      const id = e.agentId
      await update($, ledger, l => {
        const row = l.agents[id]
        return row ? { ...l, agents: { ...l.agents, [id]: { ...row, status: 'done' as const, lastAt: now } } } : l
      })
    } else {
      await update($, ledger, l => ({
        ...l,
        tasks: l.tasks.map(t => (t.turnId === e.turnId ? { ...t, endedAt: now } : t)),
      }))
      const c = await update($, cache, x => ({ ...x, busy: false, pinnedTurn: null, pinnedFrom: null }))
      if (c.queued && !isWarm(c.main, now)) await runQueued($)
      await persist($)
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (!result.agentId) return result
    const id = result.agentId
    const now = await $.clock.now()
    const t = await update($, track, x => {
      const root = e.parentAgentId ? (x.rootTurnOf[e.parentAgentId] ?? x.mainTurn) : x.mainTurn
      return root ? { ...x, rootTurnOf: { ...x.rootTurnOf, [id]: root } } : x
    })
    const root = t.rootTurnOf[id]
    await update($, ledger, l => {
      const prior = l.agents[id]
      const row: AgentRow = {
        ...(prior ?? { ...EMPTY, startedAt: now, lastAt: now, status: 'running' as const }),
        id,
        kind: 'subagent',
        label: e.description || e.name || 'subagent',
        type: e.fork ? 'fork' : e.subagentType,
        parentId: e.parentAgentId ?? 'main',
        model: prior?.model || result.model,
      }
      return {
        ...l,
        agents: { ...l.agents, [id]: row },
        tasks: root ? l.tasks.map(k => (k.turnId === root ? { ...k, agents: k.agents + 1 } : k)) : l.tasks,
      }
    })
    return result
  })

  on('tool.call', async ($, e, next) => {
    const loop = e.agentId ?? 'main'
    if (e.tool === 'Skill') {
      const skill = String((e as Record<string, unknown>).skill ?? 'skill')
      await update($, track, t => ({ ...t, skillLoop: loop, activeSkill: { ...t.activeSkill, [loop]: skill } }))
      try {
        return await next(e)
      } finally {
        await update($, track, t => ({ ...t, skillLoop: null }))
      }
    }
    if (String(e.tool) === 'Workflow') {
      const id = `wf:${e.tool_use_id}`
      const now = await $.clock.now()
      const name = workflowName(e as Record<string, unknown>)
      const row: AgentRow = {
        ...EMPTY,
        id,
        kind: 'workflow',
        label: `workflow ${name}`,
        type: 'workflow',
        model: '',
        status: 'running',
        startedAt: now,
        lastAt: now,
      }
      await update($, track, t => ({ ...t, latestWorkflow: id }))
      await update($, ledger, l => ({ ...l, agents: { ...l.agents, [id]: row } }))
    }
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    const t = await read($, track)
    const loop = t.skillLoop ?? 'main'
    if (!t.skillLoop) await update($, track, x => ({ ...x, activeSkill: { ...x.activeSkill, [loop]: e.skill } }))
    const injected = Math.round(e.text.length / 3.6)
    await update($, ledger, l => {
      const row = l.skills[e.skill] ?? { ...EMPTY, skill: e.skill, calls: 0, injectedTokens: 0 }
      return { ...l, skills: { ...l.skills, [e.skill]: { ...row, calls: row.calls + 1, injectedTokens: row.injectedTokens + injected } } }
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await setGauges($, e.rateLimits, e.cost?.usd)
    await setContext($, e.context)
    return next(e)
  })

  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    const level = e.args.trim().toLowerCase()
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(level)) {
      const now = await $.clock.now()
      await update($, ledger, l => ({ ...l, now: { model: l.now?.model ?? '', effort: level, at: now } }))
      await setStatus($)
    }
    return result
  })

  on('command.run', { command: 'model' }, async ($, e, next) => {
    const c = await read($, cache)
    const now = await $.clock.now()
    const m = c.main
    const args = e.args.trim()
    const pass = async () => {
      const result = await next(e)
      await refreshModel($)
      return result
    }
    if (c.lock === 'off' || !m || !isWarm(m, now) || keepsModel(args, m.model)) return pass()
    const left = mmss(m.expiresAt - now)
    if (args === '') {
      $.ui.toast(
        `⏱ ${shortModel(m.model)} cache is warm for ${left}: a model picked now is held to ${shortModel(m.model)} until it cools${c.lock === 'on' ? '' : ' (warn mode: not held)'}.`,
        { timeoutMs: 8000 },
      )
      return pass()
    }
    const target = targetModel(args)
    const cost = target ? switchUsd(m, target) : 0
    const costText = target ? ` ≈ ${fmtUsd(cost)} to re-write ${fmtTok(m.tokens)} tokens on ${shortModel(target)}` : ''
    if (c.lock === 'warn') {
      $.ui.toast(`⚠ Leaving a warm ${shortModel(m.model)} cache (${left} left)${costText}.`, { timeoutMs: 8000 })
      return pass()
    }
    if (c.bypassOnce) {
      await update($, cache, x => ({ ...x, bypassOnce: false }))
      return pass()
    }
    await update($, cache, x => ({ ...x, queued: args, holds: x.holds + 1, heldSavedUsd: x.heldSavedUsd + cost }))
    return {
      text: [
        `🔒 TokenScope held /model ${args}: the ${shortModel(m.model)} cache is warm for ${left} (${fmtTok(m.tokens)} tokens).`,
        `Switching now would re-write the whole prefix${costText}.`,
        `Queued: it switches by itself when the cache cools (${new Date(m.expiresAt).toLocaleTimeString()}).`,
        `/tokenscope unlock then /model ${args} to switch now · /tokenscope lock off to stop holding.`,
      ].join('\n'),
    }
  })

  on('command.run', { command: 'tokenscope' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)
    if (verb === 'lock') {
      if (!['on', 'warn', 'off'].includes(arg)) return { text: 'Usage: /tokenscope lock on|warn|off' }
      const lock = arg as CacheState['lock']
      await update($, cache, x => ({ ...x, lock, ...(lock === 'off' ? { queued: null } : {}) }))
      return { text: `TokenScope cache lock: ${lock}.` }
    }
    if (verb === 'unlock') {
      const c = await update($, cache, x => ({ ...x, bypassOnce: true, queued: null, pinnedTurn: null, pinnedFrom: null }))
      return { text: `Unlocked once: your next model switch goes through${c.main ? ` and leaves the ${shortModel(c.main.model)} cache` : ''}.` }
    }
    if (verb === 'ttl') {
      if (arg !== '5m' && arg !== '1h') return { text: 'Usage: /tokenscope ttl 5m|1h' }
      const ttl: CacheState['ttl'] = arg
      await update($, cache, x => ({
        ...x,
        ttl,
        ttlSource: 'set' as const,
        main: x.main ? { ...x.main, expiresAt: x.main.touchedAt + ttlMs(ttl) } : null,
      }))
      return { text: `TokenScope times the prompt cache at ${arg}.` }
    }
    if (verb === 'band') {
      const v = await update($, view, x => ({ ...x, band: !x.band }))
      return { text: `TokenScope band ${v.band ? 'shown' : 'hidden'}.` }
    }
    if (verb === 'receipt') {
      return { text: receipt(await read($, ledger), await read($, view), await $.clock.now()) }
    }
    if (verb === 'plan') {
      if (!PLANS[arg]) return { text: `Plans: ${Object.keys(PLANS).join(', ')}` }
      await $.store.set('plan', arg)
      await update($, view, x => ({ ...x, plan: arg }))
      return { text: `TokenScope plan set to ${PLANS[arg]?.label}.` }
    }
    if (verb === 'reset') {
      await persist($)
      const now = await $.clock.now()
      await update($, ledger, () => freshLedger(now))
      await update($, track, () => freshTrack())
      $.ui.status(undefined)
      return { text: 'TokenScope session counters reset (history kept).' }
    }
    await $.ui.open({ id: PANE, title: 'TokenScope' })
    return { text: 'TokenScope opened. Tabs: 1-7 · /tokenscope receipt for a printable receipt.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const l = await read($, ledger)
    const v = await read($, view)
    const c = await read($, cache)
    const now = await $.clock.now()
    const W = Math.max(36, e.props.bodyColumns - 1)
    const elapsedH = Math.max(1 / 60, (now - l.startedAt) / 3_600_000)
    const perHour = l.totals.usd / elapsedH
    const agentCount = Object.values(l.agents).filter(a => a.kind === 'subagent').length
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 12)

    const groups = buildGroups(l, c, now)
    let body
    if (v.tab === 'agents') body = Agents(ui, l, W, now)
    else if (v.tab === 'tasks') body = Tasks(ui, l, W, now, room)
    else if (v.tab === 'skills') body = Skills(ui, l, W)
    else if (v.tab === 'models') body = ModelCards(ui, groups, l, c, now, W)
    else if (v.tab === 'plan') body = Plan($, ui, l, v, W, now)
    else if (v.tab === 'cache') body = CacheTab($, ui, c, W, now, groups)
    else body = Overview(ui, l, W, ByModel(ui, groups, l, c, now, W))

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold color={C.brand}>
              ◆ T O K E N S C O P E
            </Text>
            <Text color={C.dim}>
              {fmtDuration(now - l.startedAt)} · {l.totals.requests} req · {agentCount} subagents
            </Text>
          </Box>
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Text bold color={C.usd}>
              {fmtUsd(l.totals.usd)}
            </Text>
            <Text color={C.dim}>API-equivalent</Text>
            <Text color={heat(perHour / 4)}>↯ {fmtUsd(perHour)}/h burn</Text>
            {v.engineUsd !== null && <Text color={C.dim}>/cost ledger {fmtUsd(v.engineUsd)}</Text>}
          </Box>
          {NowLine(ui, l, v, c, now, W)}
          {ModelStrip(ui, groups, l, c, now, W)}
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {TABS.map(([tab, label], i) => (
            <Button
              key={`tab-${tab}`}
              label={label}
              hotkey={String(i + 1)}
              variant={v.tab === tab ? 'primary' : 'secondary'}
              onPress={() => update($, view, x => ({ ...x, tab }))}
            />
          ))}
        </Box>
        {body}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    const l = await read($, ledger)
    if (e.props.hasSurvey || !v.band || (l.totals.requests === 0 && !l.now)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const c = await read($, cache)
    const now = await $.clock.now()
    const ttl = ttlMs(c.ttl)
    const t = l.totals
    type Seg = [string, string, boolean?]
    const segs: Seg[][] = []

    // what runs now, and its cache
    const n = l.now
    const head: Seg[] = [['◆ ', C.brand]]
    if (n?.model) {
      head.push([modelName(n.model), familyColor(n.model), true])
      head.push([n.effort ? `·${n.effort}` : '', n.effort ? effortColor(n.effort) : C.dim])
    }
    const m = c.main
    if (m && isWarm(m, now)) {
      head.push([` ⏱${mmss(m.expiresAt - now)}`, warmColor(m, now, ttl), true])
      if (c.lock === 'on') head.push([' 🔒', C.dim])
    } else if (m) {
      head.push([' ❄ cold', C.cold, true])
    }
    if (c.queued) head.push([` 🔁 ${c.queued}`, C.usd])
    segs.push(head)

    // every other model with a warm cache, grouped
    for (const g of buildGroups(l, c, now)) {
      if (!g.warmest || (n?.model && modelKey(n.model) === g.key)) continue
      segs.push([
        [' │ ', C.dim],
        [modelName(g.model), familyColor(g.model)],
        [` ⏱${mmss(g.warmest.expiresAt - now)}`, warmColor(g.warmest, now, ttl)],
        [g.loops.filter(x => isWarm(x.w, now)).length > 1 ? ` ×${g.loops.filter(x => isWarm(x.w, now)).length}` : '', C.dim],
      ])
    }

    segs.push([[' │ ', C.dim], [fmtUsd(t.usd), C.usd, true]])
    const ctx = v.context
    if (ctx?.percent !== undefined) segs.push([[' │ ctx ', C.dim], [`${ctx.percent}%`, ctxColor(ctx.percent), true]])
    segs.push([[' │ in ', C.dim], [fmtTok(t.input), C.in]])
    segs.push([[' c.wrt ', C.dim], [fmtTok(t.cacheWrite), C.cw]])
    segs.push([[' c.read ', C.dim], [fmtTok(t.cacheRead), C.cr]])
    segs.push([[' out ', C.dim], [fmtTok(t.output), C.out]])
    segs.push([[' │ hit ', C.dim], [pct(hitRate(t)), C.save]])
    const five = v.gauges.find(g => g.kind === 'five_hour')
    if (five) {
      const cells = Math.round(five.percentUsed / 20)
      segs.push([
        [' │ 5h ', C.dim],
        ['▰'.repeat(cells) + '▱'.repeat(5 - cells), gaugeColor(five.percentUsed)],
        [` ${five.percentUsed}%`, gaugeColor(five.percentUsed)],
      ])
    }
    segs.push([[' │ /tokenscope', C.dim]])

    let room = e.props.bodyColumns - 1
    const shown: Seg[] = []
    for (const g of segs) {
      const w = g.reduce((sum, [text]) => sum + text.length, 0)
      if (w > room) break
      room -= w
      shown.push(...g.filter(([text]) => text !== ''))
    }
    return (
      <Box flexDirection="row">
        {shown.map(([text, color, bold]) => (
          <Text color={color} bold={bold === true}>
            {text}
          </Text>
        ))}
      </Box>
    )
  })
}
