import type { CacheState, CacheWarm } from '../types'
import { CACHE_WRITE_MULTIPLIER, rateFor, shortModel } from './pricing'

export const freshCache = (): CacheState => ({
  ttl: '5m',
  ttlSource: 'default',
  lock: 'on',
  main: null,
  loops: {},
  busy: false,
  bypassOnce: false,
  queued: null,
  pinnedTurn: null,
  pinnedFrom: null,
  holds: 0,
  heldSavedUsd: 0,
  coldStarts: 0,
  coldUsd: 0,
})

export const ttlMs = (ttl: CacheState['ttl']) => (ttl === '1h' ? 3_600_000 : 300_000)

export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function isWarm(w: CacheWarm | null | undefined, now: number): boolean {
  return !!w && now < w.expiresAt
}

export const sameModel = (a: string, b: string) => shortModel(a) === shortModel(b)

const ALIASES: Record<string, string> = {
  fable: 'claude-fable-5-1',
  mythos: 'claude-mythos-5-1',
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-4-5',
}

/**
 * What `/model <args>` asks for, as a model id we can price; null when the
 * args name nothing recognisable (`default`, a custom id).
 */
export function targetModel(args: string): string | null {
  const a = args.trim().toLowerCase()
  if (/(fable|mythos|opus|sonnet|haiku)-\d/.test(a)) return a
  const family = a.match(/^(fable|mythos|opus|sonnet|haiku)\b/)?.[1]
  return family ? (ALIASES[family] ?? null) : null
}

/** Whether `/model <args>` keeps the cached model (same family/version). */
export function keepsModel(args: string, cached: string): boolean {
  const a = args.trim().toLowerCase()
  if (a === '') return true
  const target = targetModel(a)
  if (!target) return false
  const hasVersion = /(fable|mythos|opus|sonnet|haiku)-\d/.test(a)
  if (hasVersion) return sameModel(target, cached)
  return shortModel(cached).split(' ')[0] === shortModel(target).split(' ')[0]
}

/** What the next request pays extra if this cache cools: a write instead of a read. */
export function keepWarmUsd(w: CacheWarm): number {
  const r = rateFor(w.model)
  return (w.tokens * (r.input * CACHE_WRITE_MULTIPLIER - r.cacheRead)) / 1e6
}

/** What switching to `model` costs up front: the prefix written fresh on it. */
export function switchUsd(w: CacheWarm, model: string): number {
  return (w.tokens * rateFor(model).input * CACHE_WRITE_MULTIPLIER) / 1e6
}

/** green while more than half is left, amber past half, red in the last fifth. */
export function warmColor(w: CacheWarm, now: number, ttl: number): string {
  const left = (w.expiresAt - now) / ttl
  return left > 0.5 ? '#34d399' : left > 0.2 ? '#facc15' : '#f43f5e'
}
