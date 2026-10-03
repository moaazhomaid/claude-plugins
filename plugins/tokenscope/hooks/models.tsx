import type { CacheState, CacheWarm, Ledger, ModelRow, Usage4, View } from '../types'
import { isWarm, keepWarmUsd, mmss, ttlMs, warmColor } from './cache'
import { C, type Kit, ctxColor, effortColor, familyColor, lpad, modelKey, modelName, pad, pct } from './kit'
import { EMPTY, add, bar, fmtDuration, fmtTok, fmtUsd, heat, price, rateFor, tokens } from './pricing'

export type LoopCache = { id: string; label: string; w: CacheWarm }

/** Everything the session did on one model: spend, efforts, agents and its caches. */
export type Group = {
  key: string
  model: string
  row: ModelRow
  efforts: [string, Usage4][]
  loops: LoopCache[]
  warmest: CacheWarm | null
  isNow: boolean
  hasMain: boolean
  agents: string[]
  lastAt: number
}

export function loopLabel(l: Ledger, id: string): string {
  if (id === 'main') return 'main thread'
  const a = l.agents[id]
  if (!a) return 'agent'
  return a.kind === 'subagent' ? `${a.type} · ${a.label}` : a.label
}

export function buildGroups(l: Ledger, c: CacheState, now: number): Group[] {
  const groups = new Map<string, Group>()
  const ensure = (model: string): Group => {
    const key = modelKey(model)
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        model,
        row: { ...EMPTY, model },
        efforts: [],
        loops: [],
        warmest: null,
        isNow: false,
        hasMain: false,
        agents: [],
        lastAt: 0,
      }
      groups.set(key, g)
    }
    return g
  }
  const efforts = new Map<string, Map<string, Usage4>>()
  for (const row of Object.values(l.models)) {
    const g = ensure(row.model)
    g.row = { ...add(g.row, row), model: g.model }
    const e = efforts.get(g.key) ?? new Map<string, Usage4>()
    for (const [level, u] of Object.entries(row.efforts ?? {})) e.set(level, add(e.get(level) ?? { ...EMPTY }, u))
    efforts.set(g.key, e)
  }
  for (const a of Object.values(l.agents)) {
    if (!a.model || a.requests === 0) continue
    const g = ensure(a.model)
    g.agents.push(a.kind === 'main' ? 'main thread' : a.kind === 'subagent' ? `${a.type} · ${a.label}` : a.label)
    g.lastAt = Math.max(g.lastAt, a.lastAt)
  }
  const loops = { ...(c.loops ?? {}) }
  if (c.main && !loops.main) loops.main = c.main
  for (const [id, w] of Object.entries(loops)) {
    const g = ensure(w.model)
    g.loops.push({ id, label: loopLabel(l, id), w })
    g.lastAt = Math.max(g.lastAt, w.touchedAt)
    if (id === 'main' && c.main && modelKey(c.main.model) === g.key) g.hasMain = true
    if (isWarm(w, now) && (!g.warmest || w.expiresAt > g.warmest.expiresAt)) g.warmest = w
  }
  if (l.now?.model) ensure(l.now.model).isNow = true
  for (const g of groups.values()) {
    g.efforts = [...(efforts.get(g.key) ?? new Map()).entries()].sort((a, b) => b[1].usd - a[1].usd)
    g.loops.sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : b.w.expiresAt - a.w.expiresAt))
  }
  return [...groups.values()].sort((a, b) => Number(b.isNow) - Number(a.isNow) || b.row.usd - a.row.usd)
}

function effortList(g: Group, l: Ledger): string {
  const levels = g.efforts.map(([level]) => level).filter(level => level !== 'default')
  if (g.isNow && l.now?.effort && !levels.includes(l.now.effort)) levels.unshift(l.now.effort)
  return levels.slice(0, 3).join('/')
}

function warmCount(g: Group, now: number): string {
  const warm = g.loops.filter(x => isWarm(x.w, now))
  if (warm.length === 0) return ''
  const main = warm.some(x => x.id === 'main')
  const others = warm.length - (main ? 1 : 0)
  return [main ? 'main' : '', others ? `${others} agent${others === 1 ? '' : 's'}` : ''].filter(Boolean).join(' + ') + ' warm'
}

// ── the Now line ────────────────────────────────────────────────────────────

export function NowLine(ui: Kit, l: Ledger, v: View, c: CacheState, now: number, W: number) {
  const { Box, Text } = ui
  const n = l.now
  if (!n?.model) return <Text color={C.dim}>▶ NOW  waiting for the first request…</Text>
  const r = rateFor(n.model)
  const ctx = v.context
  const pctFull = ctx?.percent ?? 0
  const prefix = ctx?.tokens ?? c.main?.tokens ?? 0
  const warm = c.main !== null && isWarm(c.main, now) && modelKey(c.main.model) === modelKey(n.model)
  const warmCost = (prefix * r.cacheRead) / 1e6
  const coldCost = (prefix * r.input * 1.25) / 1e6
  const bw = W >= 100 ? 12 : 6
  return (
    <Box flexDirection="row" columnGap={1} flexWrap="wrap">
      <Text color={C.dim}>▶ NOW</Text>
      <Text bold color={familyColor(n.model)}>
        {modelName(n.model)}
      </Text>
      <Text color={n.effort ? effortColor(n.effort) : C.dim}>{n.effort ? `effort ${n.effort}` : 'effort —'}</Text>
      {ctx && ctx.tokens !== undefined && (
        <Box flexDirection="row" columnGap={1}>
          <Text color={C.dim}>│ ctx</Text>
          <Text color={ctxColor(pctFull)}>
            {fmtTok(ctx.tokens)}/{fmtTok(ctx.window)}
          </Text>
          <Text color={ctxColor(pctFull)}>{bar(pctFull / 100, bw).padEnd(bw, '·')}</Text>
          <Text color={ctxColor(pctFull)} bold>
            {pctFull}%
          </Text>
        </Box>
      )}
      {prefix > 0 && (
        <Box flexDirection="row" columnGap={1}>
          <Text color={C.dim}>│ next request</Text>
          {warm ? (
            <Box flexDirection="row" columnGap={1}>
              <Text color={C.cr} bold>
                ≈{fmtUsd(warmCost)}
              </Text>
              <Text color={C.dim}>warm · {fmtUsd(coldCost)} if cold</Text>
            </Box>
          ) : (
            <Box flexDirection="row" columnGap={1}>
              <Text color={C.cold} bold>
                ≈{fmtUsd(coldCost)}
              </Text>
              <Text color={C.dim}>re-writes the cache</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

// ── one line per model: its cache countdown ─────────────────────────────────

export function ModelStrip(ui: Kit, groups: Group[], l: Ledger, c: CacheState, now: number, W: number) {
  const { Box, Text } = ui
  const ttl = ttlMs(c.ttl)
  const bw = W >= 100 ? 14 : 8
  const shown = groups.filter(g => g.loops.length > 0 || g.isNow).slice(0, 4)
  if (shown.length === 0) return <Text color={C.dim}>⏱ no prompt cache yet</Text>
  return (
    <Box flexDirection="column">
      {shown.map(g => {
        const w = g.warmest
        const efforts = effortList(g, l)
        const lock = g.hasMain && c.lock === 'on' && w ? ' 🔒' : ''
        if (!w) {
          const last = g.loops[0]?.w
          return (
            <Box flexDirection="row" columnGap={1}>
              <Text color={C.cold} bold>
                {lpad('❄', 6)}
              </Text>
              <Text color={C.cold}>{''.padEnd(bw, '·')}</Text>
              <Text color={familyColor(g.model)} bold>
                {pad(modelName(g.model), 11)}
              </Text>
              <Text color={C.dim}>{pad(efforts, 13)}</Text>
              <Text color={C.dim}>
                {last ? `cold for ${fmtDuration(now - last.expiresAt)} · next request re-writes ~${fmtTok(last.tokens)}` : 'no cache yet'}
              </Text>
            </Box>
          )
        }
        const color = warmColor(w, now, ttl)
        return (
          <Box flexDirection="row" columnGap={1}>
            <Text color={color} bold>
              {lpad(`⏱${mmss(w.expiresAt - now)}`, 6)}
            </Text>
            <Text color={color}>{bar((w.expiresAt - now) / ttl, bw).padEnd(bw, '·')}</Text>
            <Text color={familyColor(g.model)} bold>
              {pad(modelName(g.model), 11)}
            </Text>
            <Text color={C.dim}>{pad(efforts, 13)}</Text>
            <Text color={C.text}>{warmCount(g, now)}</Text>
            <Text color={C.dim}>
              · {fmtTok(w.tokens)} tok · keeping it warm saves {fmtUsd(keepWarmUsd(w))}
              {lock}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

// ── compact by-model block for the Overview ─────────────────────────────────

export function ByModel(ui: Kit, groups: Group[], l: Ledger, c: CacheState, now: number, W: number) {
  const { Box, Text } = ui
  const used = groups.filter(g => g.row.requests > 0)
  if (used.length === 0) return null
  const max = Math.max(...used.map(g => g.row.usd), 0)
  const total = l.totals.usd || 1
  const bw = Math.max(6, Math.min(24, W - 66))
  return (
    <Box flexDirection="column">
      <Text bold color={C.brand}>
        By model
      </Text>
      {used.map(g => (
        <Box flexDirection="row" columnGap={1}>
          <Text color={familyColor(g.model)}>{g.isNow ? '▶' : '●'}</Text>
          <Text color={familyColor(g.model)} bold>
            {pad(modelName(g.model), 11)}
          </Text>
          <Text color={C.dim}>{pad(effortList(g, l) || '—', 13)}</Text>
          <Text color={g.warmest ? warmColor(g.warmest, now, ttlMs(c.ttl)) : C.cold}>
            {lpad(g.warmest ? `⏱${mmss(g.warmest.expiresAt - now)}` : '❄ cold', 7)}
          </Text>
          <Text color={C.dim}>{lpad(`${g.row.requests} req`, 8)}</Text>
          <Text color={heat(g.row.usd)} bold>
            {lpad(fmtUsd(g.row.usd), 8)}
          </Text>
          <Text color={familyColor(g.model)}>{bar(max ? g.row.usd / max : 0, bw).padEnd(bw)}</Text>
          <Text color={C.dim}>{lpad(pct(g.row.usd / total), 5)}</Text>
        </Box>
      ))}
    </Box>
  )
}

// ── the Models tab: one card per model ──────────────────────────────────────

export function ModelCards(ui: Kit, groups: Group[], l: Ledger, c: CacheState, now: number, W: number) {
  const { Box, Text } = ui
  if (groups.length === 0) return <Text color={C.dim}>No model requests yet.</Text>
  const ttl = ttlMs(c.ttl)
  const total = l.totals.usd || 1
  const inner = Math.max(20, W - 4)
  const bw = Math.max(6, Math.min(20, inner - 50))
  return (
    <Box flexDirection="column" gap={1}>
      {groups.map(g => {
        const color = familyColor(g.model)
        const r = rateFor(g.model)
        const u = g.row
        const w = g.warmest
        const emax = Math.max(...g.efforts.map(([, x]) => x.usd), 0)
        return (
          <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Text color={color} bold>
                {g.isNow ? '▶ ' : '● '}
                {modelName(g.model)}
                {g.isNow ? '  NOW' : ''}
              </Text>
              <Text>
                <Text color={heat(u.usd)} bold>
                  {fmtUsd(u.usd)}
                </Text>
                <Text color={C.dim}>
                  {' '}
                  · {pct(u.usd / total)} of spend · {u.requests} req
                </Text>
              </Text>
            </Box>
            {w ? (
              <Box flexDirection="row" columnGap={1}>
                <Text color={warmColor(w, now, ttl)} bold>
                  ⏱ {mmss(w.expiresAt - now)}
                </Text>
                <Text color={warmColor(w, now, ttl)}>{bar((w.expiresAt - now) / ttl, bw).padEnd(bw, '·')}</Text>
                <Text color={C.text}>{warmCount(g, now)}</Text>
                <Text color={C.dim}>
                  · {fmtTok(w.tokens)} tok · keeping it warm saves {fmtUsd(keepWarmUsd(w))}
                  {g.hasMain && c.lock === 'on' ? ' · 🔒 switches held' : ''}
                </Text>
              </Box>
            ) : (
              <Text color={C.cold}>
                ❄ cache cold{g.loops[0] ? ` for ${fmtDuration(now - g.loops[0].w.expiresAt)}` : ''} · the next request
                on it pays the cache write
              </Text>
            )}
            {g.efforts.length > 0 && (
              <Box flexDirection="column">
                {g.efforts.map(([level, e]) => (
                  <Box flexDirection="row" columnGap={1}>
                    <Text color={C.dim}>{pad(level === 'default' ? 'effort —' : `effort ${level}`, 14)}</Text>
                    <Text color={C.dim}>{lpad(`${e.requests} req`, 8)}</Text>
                    <Text color={C.out}>{lpad(`${fmtTok(e.requests ? e.output / e.requests : 0)} out/req`, 13)}</Text>
                    <Text color={heat(e.usd)} bold>
                      {lpad(fmtUsd(e.usd), 8)}
                    </Text>
                    <Text color={level === 'default' ? C.dim : effortColor(level)}>{bar(emax ? e.usd / emax : 0, bw)}</Text>
                  </Box>
                ))}
              </Box>
            )}
            <Box flexDirection="row" columnGap={1} flexWrap="wrap">
              <Text color={C.dim}>tokens</Text>
              <Text color={C.in}>in {fmtTok(u.input)}</Text>
              <Text color={C.cw}>c.wrt {fmtTok(u.cacheWrite)}</Text>
              <Text color={C.cr}>c.read {fmtTok(u.cacheRead)}</Text>
              <Text color={C.out}>out {fmtTok(u.output)}</Text>
              <Text color={C.dim}>· cache saved {fmtUsd(u.uncachedUsd - u.usd)}</Text>
            </Box>
            {g.agents.length > 0 && (
              <Text color={C.dim}>
                used by {pad(summarize(g.agents), Math.max(10, inner - 9))}
              </Text>
            )}
            <Text color={C.dim}>
              {r.label} list price /MTok: in ${r.input} · c.wrt ${(r.input * 1.25).toFixed(2)} · c.read ${r.cacheRead} ·
              out ${r.output}
            </Text>
          </Box>
        )
      })}
      {WhatIf(ui, l, W)}
    </Box>
  )
}

function summarize(names: string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) {
    const k = n.replace(/ · .*$/, '')
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ')
}

const CATALOG = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']

/** The session's own tokens repriced on each current model. */
export function whatIf(l: Ledger): { model: string; usd: number; isUsed: boolean }[] {
  const rows = Object.values(l.models)
  const used = new Set(rows.map(r => modelKey(r.model)))
  return CATALOG.map(model => {
    let usd = 0
    for (const r of rows) {
      usd += price(
        {
          input_tokens: r.input,
          cache_creation_input_tokens: r.cacheWrite,
          cache_read_input_tokens: r.cacheRead,
          output_tokens: r.output,
        },
        model,
      ).usd
    }
    return { model, usd, isUsed: used.has(modelKey(model)) }
  })
}

function WhatIf(ui: Kit, l: Ledger, W: number) {
  const { Box, Text } = ui
  if (tokens(l.totals) === 0) return null
  const rows = whatIf(l)
  const actual = l.totals.usd
  const max = Math.max(...rows.map(r => r.usd), actual)
  const bw = Math.max(6, Math.min(30, W - 46))
  return (
    <Box flexDirection="column">
      <Text bold color={C.brand}>
        What if the whole session ran on one model?
      </Text>
      <Box flexDirection="row" columnGap={1}>
        <Text color={C.text}>{pad('actual mix', 12)}</Text>
        <Text color={C.usd} bold>
          {lpad(fmtUsd(actual), 9)}
        </Text>
        <Text color={C.usd}>{bar(max ? actual / max : 0, bw).padEnd(bw)}</Text>
      </Box>
      {rows.map(r => {
        const delta = actual ? r.usd / actual - 1 : 0
        return (
          <Box flexDirection="row" columnGap={1}>
            <Text color={familyColor(r.model)}>{pad(modelName(r.model), 12)}</Text>
            <Text color={heat(r.usd)} bold>
              {lpad(fmtUsd(r.usd), 9)}
            </Text>
            <Text color={familyColor(r.model)}>{bar(max ? r.usd / max : 0, bw).padEnd(bw)}</Text>
            <Text color={delta <= 0 ? C.cr : C.red}>{lpad(`${delta <= 0 ? '' : '+'}${Math.round(delta * 100)}%`, 6)}</Text>
            <Text color={C.dim}>{r.isUsed ? 'used' : ''}</Text>
          </Box>
        )
      })}
      <Text color={C.dim}>
        Same token counts at each model's list price. A real run would differ in tokens and in quality.
      </Text>
    </Box>
  )
}

// ── the Cache tab: timers grouped by model, one row per agent loop ──────────

export function CacheGroups(ui: Kit, groups: Group[], c: CacheState, now: number, W: number) {
  const { Box, Text } = ui
  const ttl = ttlMs(c.ttl)
  const withCache = groups.filter(g => g.loops.length > 0)
  if (withCache.length === 0) return null
  const bw = Math.max(6, Math.min(20, W - 60))
  return (
    <Box flexDirection="column">
      <Text bold color={C.brand}>
        Caches by model
      </Text>
      {withCache.map(g => (
        <Box flexDirection="column">
          <Text color={familyColor(g.model)} bold>
            {g.isNow ? '▶ ' : '● '}
            {modelName(g.model)}
            <Text color={C.dim}> · {warmCount(g, now) || 'all cold'}</Text>
          </Text>
          {g.loops.slice(0, 8).map(x => {
            const warm = isWarm(x.w, now)
            const color = warm ? warmColor(x.w, now, ttl) : C.cold
            return (
              <Box flexDirection="row" columnGap={1}>
                <Text color={C.text}>{pad(`  ${x.label}`, Math.max(14, W - bw - 34))}</Text>
                <Text color={color} bold>
                  {lpad(warm ? mmss(x.w.expiresAt - now) : 'cold', 6)}
                </Text>
                <Text color={color}>{bar(warm ? (x.w.expiresAt - now) / ttl : 0, bw).padEnd(bw, '·')}</Text>
                <Text color={C.dim}>{lpad(`${fmtTok(x.w.tokens)} tok`, 10)}</Text>
                <Text color={C.dim}>{x.id === 'main' && c.lock === 'on' && warm ? '🔒' : ''}</Text>
              </Box>
            )
          })}
          {g.loops.length > 8 && <Text color={C.dim}>  …{g.loops.length - 8} more</Text>}
        </Box>
      ))}
    </Box>
  )
}
