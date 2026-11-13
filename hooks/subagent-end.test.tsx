import { test, expect, mock } from 'claude-code/testing'

const PANE = {
  plugin: 'task-progress',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'task-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20, total: 1 }, view: {} },
  viewport: { columns: 80, rows: 60 },
} as const
const SUB = 'abcdef123456'
const running = { id: SUB, description: 'find hooks', type: 'Explore', status: 'running' }

const harness = (on: any) => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  return clock
}

const view = async ($: any) => {
  const pane = await $.ui.mount(PANE as never)
  const header = (await pane.find({ type: 'Text', text: /\d+ running/ }))?.text?.trim()
  const history = (await pane.find({ type: 'Text', text: /^History · \d+ of \d+ finished/ }))?.text
  await pane.unmount()
  return { header, hasHistory: history !== undefined }
}
const endOfMain = ($: any) =>
  $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 'm', reason: 'answer', usage: null } as never)
const endOfSub = ($: any) =>
  $.turn.complete({ answer: 'ok', durationMs: 10, isAborted: false, turnId: 's', reason: 'answer', agentId: SUB, usage: null } as never)

test('after the main turn ends the pane still sees a running subagent end', async ($, on) => {
  const clock = harness(on)
  let listed: unknown[] = [running]
  on('agent.list', () => ({ value: listed }))

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  await endOfMain($)
  await clock.advance(500)
  // the main agent is waiting, the subagent is going
  expect(await view($)).toEqual({ header: '● 1 running · main waiting', hasHistory: false })

  // the engine reports the subagent done while nobody is prompting any more
  listed = [{ ...running, status: 'completed' }]
  await clock.advance(1000)
  expect(await view($)).toEqual({ header: '○ 0 running', hasHistory: true })
})

test('the pane polls on after the main turn only while a subagent runs, then stops', async ($, on) => {
  const clock = harness(on)
  let polls = 0
  let listed: unknown[] = [running]
  on('agent.list', () => (polls++, { value: listed }))

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  await endOfMain($)
  const atEnd = polls
  await clock.advance(2000)
  expect(polls).toBeGreaterThan(atEnd + 2) // polling carried on

  listed = []
  await clock.advance(1000)
  const settled = polls
  await clock.advance(5000)
  expect(polls).toBe(settled) // and stopped once nothing runs
})

test('a subagent whose own turn ended shows as finished even if the list still says running', async ($, on) => {
  const clock = harness(on)
  on('agent.list', () => ({ value: [running] })) // the engine never updates it

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  expect((await view($)).header).toBe('● 2 running')

  await endOfSub($)
  await clock.advance(500)
  // only the main agent is left, and the subagent is in the history
  expect(await view($)).toEqual({ header: '● 1 running', hasHistory: true })

  // a new request of its own says it works again
  for await (const _chunk of $.turn.step({ turnId: 's2', index: 0, model: 'm', effort: 'high', messageCount: 1, agentId: SUB } as never)) {
    // drain
  }
  await clock.advance(500)
  expect((await view($)).header).toBe('● 2 running')
})
