import { describe, expect, mock, test } from 'claude-code/testing'

import { keepWarmUsd, keepsModel, mmss, switchUsd, targetModel } from '../hooks/cache'

describe('cache math', () => {
  test('countdown text', async () => {
    expect(mmss(300_000)).toBe('5:00')
    expect(mmss(61_500)).toBe('1:02')
    expect(mmss(-5)).toBe('0:00')
  })

  test('which /model args keep the cached model', async () => {
    expect(keepsModel('', 'claude-opus-5-5')).toBe(true)
    expect(keepsModel('opus', 'claude-opus-5-5')).toBe(true)
    expect(keepsModel('claude-opus-5-5', 'claude-opus-5-5')).toBe(true)
    expect(keepsModel('sonnet', 'claude-opus-5-5')).toBe(false)
    expect(keepsModel('claude-opus-5', 'claude-opus-5-5')).toBe(false)
    expect(keepsModel('default', 'claude-opus-5-5')).toBe(false)
    expect(targetModel('haiku')).toBe('claude-haiku-4-5')
  })

  test('keep-warm and switch prices', async () => {
    const w = { model: 'claude-opus-5-5', touchedAt: 0, expiresAt: 1, tokens: 1_000_000, warned: false, expiredNoticed: false }
    expect(keepWarmUsd(w)).toBe(4.8) // 1M × ($4 × 1.25 − $0.20)
    expect(switchUsd(w, 'claude-sonnet-5-5')).toBe(2.5) // 1M × $2 × 1.25
  })
})

const PANE = {
  plugin: 'tokenscope',
  component: 'Pane',
  requestId: 'tokenscope',
  props: { title: 'TokenScope', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: 160, rows: 50 },
} as const

const START = Date.parse('2026-10-03T10:00:00Z')

test('a warm cache counts down, holds /model, then switches at expiry', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const switched: string[] = []
  const stepModels: string[] = []
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => e as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('ui.render', () => null as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.run', { command: 'model' }, ($, e) => {
    switched.push(e.args)
    return { text: `model set to ${e.args}` }
  })
  on('turn.step', async function* ($, e) {
    stepModels.push(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 200_000,
        output_tokens: 300,
        model: e.model,
      },
    } as never
  })
  const run = (command: string, args: string) =>
    $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  const turn = async (id: string, model: string) => {
    await $.turn.start({ text: `task ${id}`, turnId: id })
    for await (const _ of $.turn.step({ turnId: id, index: 0, model, messageCount: 3 })) void _
    await $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: id, reason: 'answer' } as never)
  }

  await $.session.start({ cwd: '/tmp' } as never)
  await turn('t1', 'claude-opus-5-5')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as never)
  expect(await ui.find({ text: /⏱5:00/ })).toBeDefined()
  await ui.press({ key: 'tab-cache' })
  expect(await ui.find({ text: /until the opus 5\.5 cache expires/ })).toBeDefined()

  // 2 minutes on: /model sonnet is held and queued, the engine's /model never runs
  await clock.advance(120_000)
  const held = await run('model', 'sonnet')
  expect(held.text).toMatch(/held \/model sonnet/)
  expect(switched).toEqual([])
  expect(await ui.find({ text: /queued: \/model sonnet/ })).toBeDefined()

  // a model picked in the menu still reaches the next turn: it is kept on Opus for that turn
  await turn('t2', 'claude-sonnet-5-5')
  expect(stepModels).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])

  // t2 refreshed the cache at +2:00, so it cools at +7:00; the queued switch runs then
  await clock.advance(4 * 60_000)
  expect(switched).toEqual([])
  await clock.advance(61_000)
  expect(switched).toEqual(['sonnet'])
  expect(await ui.find({ text: /cache expired/ })).toBeDefined()

  // cold now: a switch goes straight through
  await run('model', 'haiku')
  expect(switched).toEqual(['sonnet', 'haiku'])
  await ui.unmount()
})

test('warn mode and unlock let a switch through', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  mock.store(on)
  const switched: string[] = []
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => e as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [] } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('ui.render', () => null as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.run', { command: 'model' }, ($, e) => {
    switched.push(e.args)
    return { text: 'ok' }
  })
  on('turn.step', async function* ($, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 50_000, output_tokens: 10, model: e.model },
    } as never
  })
  const run = (command: string, args: string) =>
    $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)

  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) void _
  await clock.advance(10_000)

  await run('tokenscope', 'unlock')
  await run('model', 'sonnet')
  expect(switched).toEqual(['sonnet'])

  await run('tokenscope', 'lock warn')
  await run('model', 'haiku')
  expect(switched).toEqual(['sonnet', 'haiku'])
})
