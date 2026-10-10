import { test, expect, mock } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 5,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 5, total: 1 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'task-progress',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'task-agents',
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20, total: 1 },
    view: {},
  },
  viewport: { columns: 80, rows: 80 },
} as const

type U = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usageOf = (input: number, output: number, cached = 0, written = 0, model = 'm'): U => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cached,
  cache_creation_input_tokens: written,
})

// The engine's side: every event the mod listens to answers with a stub. `usages` says
// what a step's response reports, per agent id ('main' for the main loop; absent: no usage).
const harness = (on: any, usages: Record<string, U | null>, listed: unknown[] = [], pricing = '') => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('http.fetch', () => ({
    value: { status: pricing === '' ? 503 : 200, ok: pricing !== '', headers: {}, text: pricing },
  }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('agent.list', () => ({ value: listed }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('turn.step', async function* (_$: any, e: any) {
    // give a concurrent request the chance to run in between
    await Promise.resolve()
    await Promise.resolve()
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: usages[e.agentId ?? 'main'] ?? null,
    }
  })
  return clock
}

const step = async ($: any, turnId: string, agentId?: string) => {
  for await (const _chunk of $.turn.step({ turnId, index: 0, model: 'm', messageCount: 1, agentId })) {
    // drain the stream: the hook runs as the stream is read
  }
}

const complete = ($: any, turnId: string, usage?: U, agentId?: string) =>
  $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: usage === undefined, turnId, reason: 'answer', usage, agentId })

const textsOf = async (ui: any, pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern }))?.text

test('two subagents counted at the same time: session, turn and per-agent figures agree', async ($, on) => {
  const clock = harness(
    on,
    { a1000000aaaa: usageOf(1000, 100, 5000, 0), b2000000bbbb: usageOf(2000, 200, 0, 1000) },
    [
      { id: 'a1000000aaaa', description: 'first job', type: 'Explore', status: 'running' },
      { id: 'b2000000bbbb', description: 'second job', type: 'Plan', status: 'running' },
    ],
  )
  await $.prompt.submit({ text: 'go' } as never)
  await Promise.all([step($, 'ta', 'a1000000aaaa'), step($, 'tb', 'b2000000bbbb')])
  await clock.advance(500)

  const pane = await $.ui.mount(PANE as never)
  // session = sum of the agents = the turn (one prompt): 9000 in, 5000 of it cached, 300 out
  expect(await textsOf(pane, /^\s*9\.0k in \(5\.0k cached\) · 300 out$/)).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /6\.1k tok · 6\.0k in \(5\.0k cached\) · 100 out/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /3\.2k tok · 3\.0k in · 200 out/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /counted: 2\/2 requests/ })).toBeDefined()
  await pane.unmount()

  const band = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', ...BAND } as never)
  expect(
    await band.find({ type: 'Text', text: /turn 9\.0k in \(5\.0k cached\) · 300 out · session 9\.0k in \(5\.0k cached\) · 300 out/ }),
  ).toBeDefined()
  await band.unmount()
})

const pane = async ($: any, ctx: any = PANE) => $.ui.mount(ctx as never)
const sessionText = (ui: any, pattern: RegExp) => ui.find({ type: 'Text', text: pattern })

test('a turn without usage in its steps is counted once from its closing report, never twice', async ($, on) => {
  const usages: Record<string, U | null> = { main: null }
  harness(on, usages)
  await $.prompt.submit({ text: 'go' } as never)

  // turn z: its step reports nothing, so the closing report adds it, once
  await step($, 'z')
  await complete($, 'z', usageOf(100, 200, 300, 50))
  let ui = await pane($)
  expect(await sessionText(ui, /^\s*450 in \(300 cached\) · 200 out$/)).toBeDefined()
  expect(await sessionText(ui, /counted: 0\/1 requests · 1 turns/)).toBeDefined()
  await ui.unmount()

  // turn y: its step already counted everything, so the closing report adds nothing
  usages.main = usageOf(10, 20, 30, 5)
  await step($, 'y')
  await complete($, 'y', usageOf(10, 20, 30, 5))
  ui = await pane($)
  expect(await sessionText(ui, /^\s*495 in \(330 cached\) · 220 out$/)).toBeDefined()
  expect(await sessionText(ui, /counted: 1\/2 requests · 2 turns/)).toBeDefined()
  await ui.unmount()

  // a report larger than what the steps counted adds only the difference
  await step($, 'x')
  await complete($, 'x', usageOf(15, 20, 30, 5))
  ui = await pane($)
  expect(await sessionText(ui, /^\s*545 in \(360 cached\) · 240 out$/)).toBeDefined()
  await ui.unmount()
})

test('an aborted turn (no usage in its closing report) forgets what its steps counted', async ($, on) => {
  const usages: Record<string, U | null> = { main: usageOf(10, 20, 30, 5) }
  harness(on, usages)
  await $.prompt.submit({ text: 'go' } as never)
  await step($, 'q')
  await complete($, 'q', undefined)
  let ui = await pane($)
  expect(await sessionText(ui, /^\s*45 in \(30 cached\) · 20 out$/)).toBeDefined()
  await ui.unmount()

  // The same turn id turns up again with no request counted: had the first run's entry
  // stayed behind, it would be taken for this run's and the closing report would add
  // nothing.
  usages.main = null
  await step($, 'q')
  await complete($, 'q', usageOf(10, 20, 30, 5))
  ui = await pane($)
  expect(await sessionText(ui, /^\s*90 in \(60 cached\) · 40 out$/)).toBeDefined()
  await ui.unmount()
})

test('session.end with reason clear resets every figure; fetched prices stay', async ($, on) => {
  const PRICING = [
    '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
    '| :-- | :-- | :-- | :-- | :-- | :-- |',
    '| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok | $50 / MTok |',
    '| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok | $20 / MTok |',
    '| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |',
    '| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok | $10 / MTok |',
    '| Claude Haiku 5.5 | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |',
  ].join('\n')
  harness(on, { main: usageOf(1000, 500, 100000, 2000, 'claude-opus-5-5') }, [], PRICING)
  on('tool.call', () => ({ result: { text: 'ok' } }))
  await $.prompt.submit({ text: 'go' } as never)
  await step($, 'k')
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'c1' } as never)

  const before = await pane($)
  expect(await sessionText(before, /^\s*103\.0k in \(100\.0k cached\) · 500 out · est\./)).toBeDefined()
  expect(await sessionText(before, /1 tools/)).toBeDefined()
  expect(await sessionText(before, /5 prices/)).toBeDefined()
  await before.unmount()
  const bandBefore = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', ...BAND } as never)
  expect(await sessionText(bandBefore, /session 103\.0k in/)).toBeDefined()
  await bandBefore.unmount()

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)

  const after = await pane($)
  expect(await sessionText(after, /^\s*0 in · 0 out$/)).toBeDefined()
  expect(await sessionText(after, /103\.0k/)).toBeUndefined()
  expect(await sessionText(after, /no tokens yet/)).toBeDefined()
  expect(await sessionText(after, /0 tools/)).toBeDefined()
  expect(await sessionText(after, /counted: 0\/0 requests · 0 turns/)).toBeDefined()
  // the prices are not part of the session
  expect(await sessionText(after, /5 prices/)).toBeDefined()
  await after.unmount()

  // the band shows no tokens either: no run is going, and no figure is left
  const band = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', ...BAND } as never)
  expect(await sessionText(band, /session/)).toBeUndefined()
  await band.unmount()

  // what is counted after the clear starts from zero
  await $.prompt.submit({ text: 'again' } as never)
  await step($, 'k2')
  const again = await pane($)
  expect(await sessionText(again, /^\s*103\.0k in \(100\.0k cached\) · 500 out · est\./)).toBeDefined()
  await again.unmount()
})

test('pruning keeps the main agent and caps the other agents, oldest first out', async ($, on) => {
  const usages: Record<string, U | null> = { main: usageOf(1, 1) }
  const id = (i: number) => `agent${String(i).padStart(2, '0')}`
  for (let i = 0; i < 50; i++) usages[id(i)] = usageOf(1, 1)
  const clock = harness(on, usages, [
    { id: id(0), description: 'oldest', type: 'Explore', status: 'running' },
    { id: id(49), description: 'newest', type: 'Explore', status: 'running' },
  ])
  await $.prompt.submit({ text: 'go' } as never)
  // the main agent counts first, so it is the oldest entry of all
  await step($, 'tm')
  for (let i = 0; i < 50; i++) await step($, `t${i}`, id(i))

  await clock.advance(500)
  const ui = await pane($)
  // the turn total keeps every request; the session total is the sum of what is kept:
  // the main agent and the 40 newest others
  expect(await sessionText(ui, /^\s*51 in · 51 out$/)).toBeDefined()
  expect(await sessionText(ui, /^\s*41 in · 41 out$/)).toBeDefined()
  // the main agent is still there, the oldest agent has lost its figures and its setup
  expect(await sessionText(ui, /^\s*2 tok · 1 in · 1 out$/)).toBeDefined()
  expect(await sessionText(ui, /^\s*agent00 · running$/)).toBeDefined()
  expect(await sessionText(ui, /^\s*agent49 · running · m$/)).toBeDefined()
  expect(await sessionText(ui, /^\s*0 tools · no tokens yet$/)).toBeDefined()
  await ui.unmount()
})
