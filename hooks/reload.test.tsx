import { test, expect, mock } from 'claude-code/testing'

const NOW = 1_800_000_000_000
const ZERO = { input: 0, output: 0, cached: 0, written: 0, cost: 0, unpriced: 0 }
// What an earlier load of the mod saved for the session: 100.0k in (90.0k cached), 5.0k out.
const SAVED = {
  at: NOW,
  ledger: {
    turn: ZERO,
    agents: [{ agentId: 'main', input: 10_000, output: 5_000, cached: 90_000, written: 0, cost: 0, unpriced: 0 }],
    seen: [],
    retired: ZERO,
  },
}
const PANE = {
  plugin: 'task-progress',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'task-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20, total: 1 }, view: {} },
  viewport: { columns: 80, rows: 60 },
} as const

const harness = (on: any, id: string, memory: Map<string, unknown>) => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: NOW })
  on('store.get', (_$: any, e: any) => ({ value: memory.get(e.key) }))
  on('store.set', (_$: any, e: any) => (memory.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_$: any, e: any) => (memory.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...memory.keys()] }))
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: id }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('turn.step', async function* (_$: any, e: any) {
    // 1.0k fresh + 4.0k read = 5.0k in, 500 out
    const usage = { model: 'm', input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  return clock
}

const request = async ($: any, turnId: string) => {
  for await (const _chunk of $.turn.step({ turnId, index: 0, model: 'm', effort: 'high', messageCount: 1 } as never)) {
    // drain the stream: the hook runs as the stream is read
  }
}
const sessionLine = async ($: any, re: RegExp) => {
  const pane = await $.ui.mount(PANE as never)
  const found = await pane.find({ type: 'Text', text: re })
  await pane.unmount()
  return found?.text as string | undefined
}

test('a reload in the middle of a turn keeps the totals saved before it', async ($, on) => {
  const memory = new Map<string, unknown>([['ledger:r1', SAVED]])
  const clock = harness(on, 'r1', memory)

  // No session.start and no prompt: the mod was reloaded while the turn ran, and the
  // first thing it sees is the turn's next request.
  await request($, 't1')

  // saved 100.0k + 5.0k from this request, 5.0k + 500 out
  expect(await sessionLine($, /^\s*105\.0k in \(94\.0k cached\) · 5\.5k out$/)).toBeDefined()
  // and the turn only holds what came after the reload
  expect(await sessionLine($, /^\s*5\.0k in \(4\.0k cached\) · 500 out$/)).toBeDefined()

  // the turn's end saves: the saved copy now holds both, not just the new part
  await $.turn.complete({
    answer: 'ok',
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    usage: { model: 'm', input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 0 },
  } as never)
  await clock.advance(500)
  const saved = memory.get('ledger:r1') as { ledger: { agents: { agentId: string; input: number; cached: number; output: number }[] } }
  const main = saved.ledger.agents.find(a => a.agentId === 'main')
  expect(main).toMatchObject({ input: 11_000, cached: 94_000, output: 5_500 })
})

test('the saved totals are taken back once, not again at the next prompt', async ($, on) => {
  const memory = new Map<string, unknown>([['ledger:r2', SAVED]])
  harness(on, 'r2', memory)

  await $.prompt.submit({ text: 'go' } as never)
  await request($, 't2')
  await $.prompt.submit({ text: 'again' } as never)

  // 100.0k + 5.0k, counted once however many prompts came after the restore
  expect(await sessionLine($, /^\s*105\.0k in \(94\.0k cached\) · 5\.5k out$/)).toBeDefined()
})
