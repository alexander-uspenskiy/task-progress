import { test, expect, mock } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5, total: 1 }, view: {} },
} as const

const PANE = {
  plugin: 'task-progress',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'task-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20, total: 1 }, view: {} },
  viewport: { columns: 80, rows: 60 },
} as const

// What the subagent's own transcript says: message `a` is written twice while it streams,
// the first line with a partial output count (5, ending at 50); message `b` once.
const TRANSCRIPT = [
  { type: 'user', message: { role: 'user', content: 'go' } },
  { type: 'assistant', message: { id: 'a', model: 'claude-unlisted-9', usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
  { type: 'assistant', message: { id: 'a', model: 'claude-unlisted-9', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } },
  { type: 'assistant', message: { id: 'b', model: 'claude-unlisted-9', usage: { input_tokens: 10, output_tokens: 40, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } } },
]
  .map(row => JSON.stringify(row))
  .join('\n')

const reads: string[] = []
const harness = (on: any, opts: { store?: Record<string, unknown>; memory?: Map<string, unknown>; transcript?: string | null } = {}) => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  if (opts.memory === undefined) {
    mock.store(on, opts.store ?? {})
  } else {
    // a store the test can look into: `$.store` is not reachable from a test
    const m = opts.memory
    on('store.get', (_$: any, e: any) => ({ value: m.get(e.key) }))
    on('store.set', (_$: any, e: any) => (m.set(e.key, e.value), { value: undefined }))
    on('store.delete', (_$: any, e: any) => (m.delete(e.key), { value: undefined }))
    on('store.keys', () => ({ value: [...m.keys()] }))
  }
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 's1' }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('classic.SubagentStop', () => ({}))
  on('classic.Stop', () => ({}))
  on('fs.read', (_$: any, e: any) => (reads.push(e.path), opts.transcript === null ? { deny: 'no such file' } : { value: opts.transcript ?? TRANSCRIPT }))
  return clock
}

const text = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text as string | undefined

test('a subagent whose requests never reached the hooks is counted from its own transcript when it stops', async ($, on) => {
  const clock = harness(on)
  on('agent.list', () => ({
    value: [{ id: 'h1000000aaaa', description: 'find hooks', type: 'Explore', status: 'completed' }],
  }))
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)

  const stop = () =>
    $.classic.SubagentStop({
      agent_id: 'h1000000aaaa',
      agent_type: 'Explore',
      stop_hook_active: false,
      agent_transcript_path: '/x/subagents/agent-h1000000aaaa.jsonl',
    } as never)
  await stop()
  // a second stop (or a repeat) adds nothing: only what is missing is counted
  await stop()

  const ui = await $.ui.mount(PANE as never)
  // full input 100 + 1000 + 10 + 2000 = 3110, output 50 + 40 = 90 -> 3.2k, message `a` once
  expect(await text(ui, /^History · 1 of 1 finished · 3\.2k tok$/)).toBeDefined()
  // the largest output of message `a` counts (50, not 5): 50 + 40 = 90
  expect(await text(ui, /^\s*3\.1k in \(3\.0k cached\) · 90 out$/)).toBeDefined()
  expect(await text(ui, /Explore · 3\.2k tok · 0 tools/)).toBeDefined()
  expect(await text(ui, /1 subagent transcripts/)).toBeDefined()
  await ui.unmount()
})

test('a transcript that cannot be read leaves the figures alone and says why', async ($, on) => {
  const clock = harness(on, { transcript: null })
  on('agent.list', () => ({
    value: [{ id: 'h2000000aaaa', description: 'x', type: 'Explore', status: 'completed' }],
  }))
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  await $.classic.SubagentStop({
    agent_id: 'h2000000aaaa',
    agent_type: 'Explore',
    stop_hook_active: false,
    agent_transcript_path: '/missing',
  } as never)
  const ui = await $.ui.mount(PANE as never)
  expect(await text(ui, /Explore · 0 tok/)).toBeDefined()
  expect(await text(ui, /error: transcript:/)).toBeDefined()
  await ui.unmount()
})

test('totals come back from the store when the ledger was lost, even from an older shape', async ($, on) => {
  // saved by an older build: no `retired`, no cost fields
  harness(on, { store: {
    'ledger:s1': {
      at: 1,
      ledger: {
        turn: { input: 0, output: 0, cached: 0, written: 0 },
        agents: [{ agentId: 'main', input: 5000, output: 700, cached: 4000, written: 0 }],
        seen: [],
      },
    },
  } })
  on('agent.list', () => ({ value: [] }))
  await $.prompt.submit({ text: 'go' } as never)

  const ui = await $.ui.mount(PANE as never)
  expect(await text(ui, /^\s*9\.0k in \(4\.0k cached\) · 700 out$/)).toBeDefined()
  await ui.unmount()
  const band = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', ...BAND } as never)
  expect(await text(band, /session 9\.0k in \(4\.0k cached\) · 700 out/)).toBeDefined()
  await band.unmount()
})

test('the ledger is saved to the store at the end of a turn, and session.end clears it', async ($, on) => {
  const memory = new Map<string, unknown>()
  const clock = harness(on, { memory })
  on('agent.list', () => ({ value: [] }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('turn.step', async function* (_$: any, e: any) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: 'm', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }
  })
  await $.prompt.submit({ text: 'go' } as never)
  for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
    // drain
  }
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)
  await clock.advance(500)

  const saved = memory.get('ledger:s1') as { ledger?: { agents?: { agentId: string; input: number }[] } } | undefined
  expect(saved?.ledger?.agents?.find(a => a.agentId === 'main')?.input).toBe(1000)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(memory.has('ledger:s1')).toBe(false)
})

test('at the end of a turn a finished subagent with no tokens is read from the session transcript folder', async ($, on) => {
  reads.length = 0
  const clock = harness(on)
  on('agent.list', () => ({
    value: [{ id: 'h3000000aaaa', description: 'old one', type: 'Explore', status: 'completed' }],
  }))
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)

  const stop = () => $.classic.Stop({ stop_hook_active: false, transcript_path: '/p/sess.jsonl' } as never)
  await stop()
  // tried once: a second turn end does not read it again
  await stop()
  expect(reads).toEqual(['/p/sess/subagents/agent-h3000000aaaa.jsonl'])

  const ui = await $.ui.mount(PANE as never)
  expect(await text(ui, /^History · 1 of 1 finished · 3\.2k tok$/)).toBeDefined()
  await ui.unmount()
})
