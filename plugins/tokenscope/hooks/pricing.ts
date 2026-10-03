import type { ModelUsage } from 'claude-code'

import type { Usage4 } from '../types'

/** USD per million tokens. Cache writes bill at 1.25x input (5-minute TTL). */
export type Rate = { input: number; output: number; cacheRead: number; label: string }

// First-party API list prices, Anthropic pricing as of 2026-09-25.
const RATES: [RegExp, Rate][] = [
  [/(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25, label: 'Fable 5.1' }],
  [/(fable|mythos)-5/, { input: 10, output: 50, cacheRead: 1, label: 'Fable 5' }],
  [/opus-5-5/, { input: 4, output: 20, cacheRead: 0.2, label: 'Opus 5.5' }],
  [/opus-5/, { input: 5, output: 25, cacheRead: 0.5, label: 'Opus 5' }],
  [/opus-4-[5-8]/, { input: 5, output: 25, cacheRead: 0.5, label: 'Opus 4.x' }],
  [/sonnet-5/, { input: 2, output: 10, cacheRead: 0.2, label: 'Sonnet 5.x' }],
  [/sonnet-4/, { input: 3, output: 15, cacheRead: 0.3, label: 'Sonnet 4.x' }],
  [/haiku-4/, { input: 1, output: 5, cacheRead: 0.1, label: 'Haiku 4.5' }],
]
const FALLBACK: Rate = { input: 4, output: 20, cacheRead: 0.2, label: 'unknown (Opus 5.5 rates)' }

export const CACHE_WRITE_MULTIPLIER = 1.25

export function rateFor(model: string): Rate {
  const id = model.toLowerCase().replace(/\./g, '-')
  return RATES.find(([pattern]) => pattern.test(id))?.[1] ?? FALLBACK
}

export function shortModel(model: string): string {
  const m = model.toLowerCase().match(/(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d))?/)
  if (!m) return model.slice(0, 14)
  return `${m[1]} ${m[2]}${m[3] ? '.' + m[3] : ''}`
}

export const EMPTY: Usage4 = {
  input: 0,
  cacheWrite: 0,
  cacheRead: 0,
  output: 0,
  usdIn: 0,
  usdCw: 0,
  usdCr: 0,
  usdOut: 0,
  usd: 0,
  uncachedUsd: 0,
  requests: 0,
}

/** One API response's tokens, priced. */
export function price(usage: ModelUsage, model: string): Usage4 {
  const r = rateFor(model)
  const input = usage.input_tokens
  const cacheWrite = usage.cache_creation_input_tokens
  const cacheRead = usage.cache_read_input_tokens
  const output = usage.output_tokens
  const usdIn = (input * r.input) / 1e6
  const usdCw = (cacheWrite * r.input * CACHE_WRITE_MULTIPLIER) / 1e6
  const usdCr = (cacheRead * r.cacheRead) / 1e6
  const usdOut = (output * r.output) / 1e6
  const uncachedUsd = ((input + cacheWrite + cacheRead) * r.input + output * r.output) / 1e6
  return {
    input,
    cacheWrite,
    cacheRead,
    output,
    usdIn,
    usdCw,
    usdCr,
    usdOut,
    usd: usdIn + usdCw + usdCr + usdOut,
    uncachedUsd,
    requests: 1,
  }
}

export function add<T extends Usage4>(row: T, u: Usage4): T {
  return {
    ...row,
    input: row.input + u.input,
    cacheWrite: row.cacheWrite + u.cacheWrite,
    cacheRead: row.cacheRead + u.cacheRead,
    output: row.output + u.output,
    usdIn: row.usdIn + u.usdIn,
    usdCw: row.usdCw + u.usdCw,
    usdCr: row.usdCr + u.usdCr,
    usdOut: row.usdOut + u.usdOut,
    usd: row.usd + u.usd,
    uncachedUsd: row.uncachedUsd + u.uncachedUsd,
    requests: row.requests + u.requests,
  }
}

export function tokens(u: Usage4): number {
  return u.input + u.cacheWrite + u.cacheRead + u.output
}

/** Share of input tokens the prompt cache served, 0..1. */
export function hitRate(u: Usage4): number {
  const all = u.input + u.cacheWrite + u.cacheRead
  return all === 0 ? 0 : u.cacheRead / all
}

export function fmtTok(n: number): string {
  const trim = (s: string) => s.replace(/\.0+$/, '')
  if (n >= 1e9) return trim((n / 1e9).toFixed(2)) + 'B'
  if (n >= 1e6) return trim((n / 1e6).toFixed(n >= 1e8 ? 0 : 1)) + 'M'
  if (n >= 1e3) return trim((n / 1e3).toFixed(n >= 1e5 ? 0 : 1)) + 'k'
  return String(Math.round(n))
}

export function fmtUsd(n: number): string {
  if (n >= 1000) return '$' + Math.round(n).toLocaleString('en-US')
  if (n >= 100) return '$' + n.toFixed(0)
  if (n >= 1) return '$' + n.toFixed(2)
  if (n >= 0.01) return '$' + n.toFixed(3)
  if (n === 0) return '$0'
  return '$' + n.toFixed(4)
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

const SPARK = '▁▂▃▄▅▆▇█'

export function sparkline(values: number[], width: number): string {
  const v = values.slice(-width)
  const max = Math.max(...v, 0)
  if (max === 0) return ''
  return v.map(x => SPARK[Math.min(7, Math.floor((x / max) * 7.999))]).join('')
}

/** A bar of `width` cells, `fraction` of it filled. */
export function bar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, fraction))
  const full = Math.floor(f * width)
  const part = f * width - full
  const partial = part > 0.66 ? '▊' : part > 0.33 ? '▌' : part > 0.05 ? '▎' : ''
  return '█'.repeat(full) + partial
}

/** Cells per segment so the segments add up to exactly `width`. */
export function split(parts: number[], width: number): number[] {
  const sum = parts.reduce((a, b) => a + b, 0)
  if (sum === 0) return parts.map(() => 0)
  const raw = parts.map(p => (p / sum) * width)
  const cells = raw.map(Math.floor)
  let left = width - cells.reduce((a, b) => a + b, 0)
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    cells[i] = (cells[i] ?? 0) + 1
    left -= 1
  }
  return cells
}

/** A heat color for a dollar amount. */
export function heat(usd: number): string {
  if (usd < 0.05) return '#34d399'
  if (usd < 0.5) return '#a3e635'
  if (usd < 2) return '#facc15'
  if (usd < 10) return '#fb923c'
  return '#f43f5e'
}

export const PLANS: Record<string, { label: string; monthly: number }> = {
  pro: { label: 'Pro', monthly: 20 },
  max5: { label: 'Max 5x', monthly: 100 },
  max20: { label: 'Max 20x', monthly: 200 },
  api: { label: 'API (pay as you go)', monthly: 0 },
}
