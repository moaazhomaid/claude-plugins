import type { Elements } from 'claude-code'

import { shortModel } from './pricing'

export type Kit = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

export const C = {
  in: '#38bdf8',
  cw: '#f59e0b',
  cr: '#34d399',
  out: '#e879f9',
  usd: '#facc15',
  save: '#2dd4bf',
  brand: '#a78bfa',
  dim: '#64748b',
  text: '#e2e8f0',
  cold: '#93c5fd',
  red: '#f43f5e',
}

export const pad = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + '…' : s.padEnd(w))
export const lpad = (s: string, w: number) => (s.length > w ? s.slice(0, w) : s.padStart(w))
export const pct = (x: number) => `${(x * 100).toFixed(x >= 0.995 || x === 0 ? 0 : 1)}%`

/** One color per model family, so a model reads the same everywhere. */
export function familyColor(model: string): string {
  const m = model.toLowerCase()
  if (/fable|mythos/.test(m)) return '#fbbf24'
  if (/opus/.test(m)) return '#c4b5fd'
  if (/sonnet/.test(m)) return '#fb7185'
  if (/haiku/.test(m)) return '#bef264'
  return C.text
}

/** `opus 5.5` → `Opus 5.5`. */
export function modelName(model: string): string {
  if (!model) return 'model —'
  const s = shortModel(model)
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The group key: ids that differ only by date, context suffix or provider prefix group together. */
export const modelKey = (model: string) => shortModel(model)

export function effortLabel(effort: string | number | undefined): string {
  if (effort === undefined || effort === '') return ''
  if (typeof effort === 'number') return effort >= 1000 ? `${Math.round(effort / 1000)}k budget` : `${effort} budget`
  return effort
}

const EFFORT_COLORS: Record<string, string> = {
  low: '#86efac',
  medium: '#fde68a',
  high: '#fdba74',
  xhigh: '#fb923c',
  max: '#f43f5e',
}

export const effortColor = (effort: string) => EFFORT_COLORS[effort] ?? C.text

export function ctxColor(percent: number): string {
  return percent < 60 ? C.cr : percent < 80 ? C.usd : C.red
}
