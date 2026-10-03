import { describe, expect, mock, test } from 'claude-code/testing'

import { price, rateFor, sparkline, split } from '../hooks/pricing'

const M = 1_000_000
const usage = (input: number, cw: number, cr: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: cw,
  cache_read_input_tokens: cr,
  output_tokens: output,
})

describe('pricing', () => {
  test('Opus 5.5 prices each token kind at its own rate', async () => {
    const u = price(usage(M, M, M, M), 'claude-opus-5-5')
    expect(u.usdIn).toBe(4)
    expect(u.usdCw).toBe(5)
    expect(u.usdCr).toBe(0.2)
    expect(u.usdOut).toBe(20)
    expect(u.usd).toBe(29.2)
    expect(u.uncachedUsd).toBe(32)
  })

  test('model ids resolve with suffixes and provider prefixes', async () => {
    expect(rateFor('claude-fable-5-1').cacheRead).toBe(0.25)
    expect(rateFor('claude-fable-5').cacheRead).toBe(1)
    expect(rateFor('claude-haiku-4-5-20251001').input).toBe(1)
    expect(rateFor('us.anthropic.claude-sonnet-4-6[1m]').input).toBe(3)
    expect(rateFor('claude-sonnet-5-5').output).toBe(10)
  })

  test('bars split to the exact width', async () => {
    expect(split([1, 1, 1], 10).reduce((a, b) => a + b, 0)).toBe(10)
    expect(sparkline([0, 1, 2], 3)).toBe('▁▄█')
  })
})

const PANE = {
  plugin: 'tokenscope',
  component: 'Pane',
  requestId: 'tokenscope',
  props: {
    title: 'TokenScope',
    isFocused: true,
    bodyColumns: 110,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
  viewport: { columns: 160, rows: 50 },
} as const

test('steps, subagents and skills land in the pane on every surface', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-03T10:00:00Z') })
  mock.store(on)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('session.start', ($, e) => e as never)
  on('session.usage', () =>
    ({
      value: {
        startedAt: 0,
        context: { tokens: 412_000, window: 1_000_000, percent: 41 },
        rateLimits: [{ kind: 'five_hour', percentUsed: 41, resetsAt: '2026-10-03T12:00:00Z' }],
        cost: { usd: 1.23 },
      },
    }) as never,
  )
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('ui.render', () => null as never)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
  on('skill.prompt', ($, e) => ({ text: e.text }))
  on('turn.step', async function* ($, e) {
    const isSub = e.agentId === 'agent-1'
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { ...usage(2000, 30000, isSub ? 0 : 400000, 1500), model: isSub ? 'claude-haiku-4-5' : 'claude-opus-5-5' },
    } as never
  })

  await $.session.start({ cwd: '/tmp' } as never)
  await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
  await $.skill.prompt({ skill: 'commit', text: 'x'.repeat(3600) })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 1 })) void _
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'scan',
    description: 'scan repo',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  } as never)
  for await (const _ of $.turn.step({ turnId: 's1', index: 0, model: 'claude-haiku-4-5', effort: 'low', messageCount: 1, agentId: 'agent-1' }))
    void _

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    expect(await ui.find({ text: /T O K E N S C O P E/ })).toBeDefined()
    expect(await ui.find({ text: 'Opus 5.5' })).toBeDefined()
    expect(await ui.find({ text: 'effort xhigh' })).toBeDefined()
    expect(await ui.find({ text: /412k\/1M/ })).toBeDefined()
    expect(await ui.find({ text: 'By model' })).toBeDefined()
    expect(await ui.find({ text: 'CACHE READ' })).toBeDefined()
    await ui.press({ key: 'tab-agents' })
    expect(await ui.find({ text: /Explore · scan repo/ })).toBeDefined()
    expect(await ui.find({ text: /haiku 4\.5·low/ })).toBeDefined()
    await ui.press({ key: 'tab-tasks' })
    expect(await ui.find({ text: /\[opus·xhigh\] fix the login bug/ })).toBeDefined()
    await ui.press({ key: 'tab-skills' })
    expect(await ui.find({ text: '/commit' })).toBeDefined()
    await ui.press({ key: 'tab-models' })
    expect(await ui.find({ text: /Haiku 4\.5/ })).toBeDefined()
    expect(await ui.find({ text: /effort xhigh/ })).toBeDefined()
    expect(await ui.find({ text: /What if the whole session ran on one model/ })).toBeDefined()
    await ui.press({ key: 'tab-plan' })
    await ui.press({ key: 'plan-max20' })
    expect(await ui.find({ text: /plan leverage/ })).toBeDefined()
    await ui.press({ key: 'tab-cache' })
    expect(await ui.find({ text: /cache expires/ })).toBeDefined()
    expect(await ui.find({ text: 'Caches by model' })).toBeDefined()
    await ui.press({ key: 'lock-warn' })
    await ui.press({ key: 'lock-on' })
    await ui.press({ key: 'tab-overview' })
    await ui.unmount()
  }

  const band = await $.ui.mount({
    plugin: 'tokenscope',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} },
  } as never)
  expect(await band.find({ text: /c\.read/ })).toBeDefined()
  expect(await band.find({ text: 'Opus 5.5' })).toBeDefined()
  expect(await band.find({ text: '·xhigh' })).toBeDefined()
  expect(await band.find({ text: 'Haiku 4.5' })).toBeDefined()
  await band.unmount()

  const run = (args: string) =>
    $.command.run({
      command: 'tokenscope',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: true, columns: 160 },
    } as never)
  const r = await run('receipt')
  expect(r.text).toMatch(/T O K E N S C O P E/)
  expect(r.text).toMatch(/Explore · scan repo/)
  expect(r.text).toMatch(/skill \/commit ×1/)
  expect(r.text).toMatch(/Plan leverage/)
})
