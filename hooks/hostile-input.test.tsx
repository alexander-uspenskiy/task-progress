import { test, expect, mock } from 'claude-code/testing'

const BAND = {
  plugin: 'task-progress',
  surface: 'terminal',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5, total: 1 }, view: {} },
} as const

const PANE = {
  plugin: 'task-progress',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'task-agents',
  props: { title: 'Agents', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20, total: 1 }, view: {} },
  viewport: { columns: 80, rows: 80 },
} as const

const usage = (input: number | string | null, output: number | string | null, cached: number | string | null = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cached,
  cache_creation_input_tokens: 0,
})
const asst = (id: unknown, model: unknown, u: unknown) => ({ type: 'assistant', message: { id, model, usage: u } })

type Env = {
  memory?: Map<string, unknown>
  store?: Record<string, unknown>
  transcript?: string | null
  home?: string
  deny?: string
}
// The engine's side: every event the mod listens to answers with a stub. `reads` and
// `exists` record the paths the mod asked about.
const harness = (on: any, opts: Env = {}) => {
  const reads: string[] = []
  const exists: string[] = []
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  if (opts.memory === undefined) {
    mock.store(on, opts.store ?? {})
  } else {
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
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('classic.SubagentStop', () => ({}))
  on('classic.Stop', () => ({}))
  on('env.get', () => ({ value: opts.home ?? '/home/u' }))
  on('fs.list', () => ({ value: [{ name: '-proj', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.exists', (_$: any, e: any) => (exists.push(e.path), { value: false }))
  on('fs.read', (_$: any, e: any) => {
    reads.push(e.path)
    return opts.deny !== undefined
      ? { deny: opts.deny }
      : opts.transcript === null || opts.transcript === undefined
      ? { deny: 'no such file' }
      : { value: opts.transcript }
  })
  return { clock, reads, exists }
}

// odd figures: not-a-number, infinity, exponent notation, a negative one
const BAD = /NaN|Infinity|undefined|e\+|(?:^|\s)-\d/
const lines = (rows: unknown[]) => rows.map(r => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n')
const allText = async (ui: any) =>
  ((await ui.findAll({ type: 'Text' })) as { text?: string }[]).map(t => t.text ?? '').join('\n')
const has = async (ui: any, re: RegExp) => (await ui.find({ type: 'Text', text: re })) !== undefined
const paneText = async ($: any) => {
  const ui = await $.ui.mount(PANE as never)
  const t = await allText(ui)
  await ui.unmount()
  return t
}
const listed = (on: any, ...ids: string[]) =>
  on('agent.list', () => ({
    value: ids.map(id => ({ id, description: 'job', type: 'Explore', status: 'completed' })),
  }))
const stopAgent = ($: any, id: string, path = '/x/subagents/agent.jsonl') =>
  $.classic.SubagentStop({ agent_id: id, agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: path } as never)
const stopTurn = ($: any, path = '/p/sess.jsonl') =>
  $.classic.Stop({ stop_hook_active: false, transcript_path: path } as never)
const turnUsage = (input: number, output: number) => ({
  model: 'm',
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
})
const completeTurn = ($: any) =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)

test('one hostile transcript line does not stop the others being counted, and it is fast', async ($, on) => {
  const sane = [
    asst('a', 'claude-unlisted-9', usage(100, 5, 1000)),
    asst('a', 'claude-unlisted-9', usage(100, 50, 1000)),
    asst('b', 'claude-unlisted-9', usage(10, 40, 2000)),
  ]
  const hostile = [
    'null',
    '7',
    '"text"',
    '[1,2]',
    'not json at all {',
    '{"type":"assistant","message":null}',
    '{"type":"assistant","message":5}',
    '{"type":"assistant","message":{"id":"m1","usage":null}}',
    '{"type":"assistant","message":{"id":"m2","usage":[1]}}',
    '{"type":"assistant","message":{"id":12,"usage":{"input_tokens":9}}}',
    asst('x'.repeat(201), 'm', usage(9, 9)),
    // absurd numbers count as nothing (or as the largest allowed), never as NaN
    asst('abs1', 'claude-unlisted-9', usage(-5, -5, '12')),
    // the model is a hundred thousand brackets
    asst('mod', '['.repeat(100_000), usage(0, 0)),
    // a copy of a line that is already there
    sane[2],
  ]
  const { clock } = harness(on, { transcript: lines([...hostile.slice(0, 6), sane[0], ...hostile.slice(6), sane[1], sane[2]]) })
  listed(on, 'h1000000aaaa')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)

  const t0 = Date.now()
  await stopAgent($, 'h1000000aaaa')
  await clock.settle()
  expect(Date.now() - t0).toBeLessThan(3000)

  const text = await paneText($)
  // message `a` once (largest output 50), `b` once: 100 + 1000 + 10 + 2000 in, 90 out
  expect(text).toMatch(/3\.1k in \(3\.0k cached\) · 90 out/)
  expect(text).not.toMatch(BAD)
  // the model is cut to 80 characters
  expect(text).not.toMatch(/\[{81}/)
  expect(text).not.toMatch(/error: transcript/)
})

test('absurd numbers are clamped, and sums stay finite', async ($, on) => {
  const { clock } = harness(on, {
    transcript: lines([
      asst('big1', 'claude-unlisted-9', usage(1e308, 1e308, 1e308)),
      asst('big2', 'claude-unlisted-9', usage(1e308, 1e308, 1e308)),
      asst('big3', 'claude-unlisted-9', usage(Number.MAX_VALUE, 1, 1)),
    ]),
  })
  listed(on, 'h2000000aaaa')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  await stopAgent($, 'h2000000aaaa')
  await clock.settle()
  const text = await paneText($)
  expect(text).not.toMatch(BAD)
  expect(text).toMatch(/ in /)
})

test('a transcript with more than 300,000 lines is cut off, not read to the end', async ($, on) => {
  const { clock } = harness(on, {
    transcript: `${'\n'.repeat(350_000)}${lines([asst('late', 'claude-unlisted-9', usage(500, 500))])}`,
  })
  listed(on, 'h3000000aaaa')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  const t0 = Date.now()
  await stopAgent($, 'h3000000aaaa')
  await clock.settle()
  expect(Date.now() - t0).toBeLessThan(3000)
  expect(await paneText($)).toMatch(/Explore · 0 tok/)
})

test('a transcript over the 4 MiB read limit is left alone, said so without a path, and not tried again', async ($, on) => {
  // the engine's own refusal of a read over its limit
  const { clock, reads } = harness(on, {
    home: '/Users/alex',
    deny: 'read of /Users/alex/.claude/projects/p/s/subagents/agent-h4000000aaaa.jsonl: file over 4 MiB',
  })
  listed(on, 'h4000000aaaa')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  reads.length = 0

  await stopTurn($)
  await clock.settle()
  expect(reads).toHaveLength(1)
  // the next end of a turn does not read it again
  await stopTurn($)
  await clock.settle()
  await clock.advance(30_000)
  expect(reads).toHaveLength(1)

  const text = await paneText($)
  expect(text).toMatch(/Explore · 0 tok/)
  expect(text).toMatch(/error: transcript over 4 MiB, not counted/)
  expect(text).not.toMatch(/\/Users|alex|\.claude|\.jsonl/)
})

test('a transcript the size of which says it is over the limit is not read at all', async ($, on) => {
  const { clock, reads } = harness(on, { transcript: lines([asst('a', 'm', usage(1, 1))]) })
  on('fs.stat', () => ({ value: { kind: 'file', size: 5 * 1024 * 1024, mtimeMs: 0, isLink: false } }))
  listed(on, 'h5000000aaaa')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  reads.length = 0
  await stopAgent($, 'h5000000aaaa', '/home/u/.claude/projects/p/s/subagents/agent-h5000000aaaa.jsonl')
  await clock.settle()
  expect(reads).toEqual([])
  const text = await paneText($)
  expect(text).toMatch(/error: transcript over 4 MiB, not counted/)
  expect(text).not.toMatch(/\/home|\.claude/)
})

test('a path or the home directory in an error never reaches the pane', async ($, on) => {
  const { clock } = harness(on, {
    home: '/Users/alex',
    deny: "EACCES: permission denied, open '/Users/alex/.claude/projects/secret/s.jsonl' and C:\\Users\\alex\\x",
  })
  listed(on, 'h6000000aaaa')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  await stopAgent($, 'h6000000aaaa', '/Users/alex/.claude/projects/secret/s.jsonl')
  await clock.settle()
  const text = await paneText($)
  expect(text).toMatch(/error: transcript: /)
  expect(text).not.toMatch(/Users|alex|secret|projects|\\|\.jsonl/)
})

test('an agent id that is not a plain name is never turned into a path', async ($, on) => {
  const { clock, reads, exists } = harness(on, { transcript: lines([asst('a', 'm', usage(1, 1))]) })
  const bad = ['../../etc', 'x/y', 'a..b', '..', 'a b', 'x'.repeat(129), 'h/../../../etc/passwd']
  listed(on, ...bad)
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  await clock.settle()
  await stopTurn($)
  await clock.settle()
  for (const id of bad) await stopAgent($, id, `/p/agent-${id}.jsonl`)
  await clock.settle()
  await clock.advance(30_000)
  await clock.settle()

  const asked = [...reads, ...exists]
  expect(reads).toEqual([])
  for (const p of asked) expect(p).not.toMatch(/\.\.|x\/y|etc|a b|agent-x{129}/)
  // and a plain name still works
  await $.classic.SubagentStop({ agent_id: 'h7000000aaaa', agent_type: 'Explore', stop_hook_active: false, agent_transcript_path: '/p/ok.jsonl' } as never)
  await clock.settle()
  expect(reads).toEqual(['/p/ok.jsonl'])
})

test('a base that is not a .jsonl path is skipped silently', async ($, on) => {
  const { clock, reads } = harness(on, { transcript: lines([asst('a', 'm', usage(1, 1))]) })
  listed(on, 'h8000000aaaa')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  reads.length = 0
  for (const path of ['/p/sess', '', '/p/sess.jsonl/../../x', 42 as never, null as never]) {
    await stopTurn($, path)
  }
  await clock.settle()
  expect(reads).toEqual([])
  expect(await paneText($)).not.toMatch(/error:/)
})

test('a tampered ledger and history in the store cannot break the bar or show odd figures', async ($, on) => {
  const many = Array.from({ length: 150 }, (_v, i) => ({ agentId: `x${i}`, input: 10, output: 0, cached: 0, written: 0 }))
  const { clock } = harness(on, {
    store: {
      'ledger:s1': {
        at: 'yesterday',
        ledger: {
          turn: { input: 'abc', output: -5, cached: Number.NaN, written: Number.POSITIVE_INFINITY, cost: 1e308, unpriced: {} },
          agents: [null, 7, 'x', { agentId: 3 }, { agentId: 'main', input: '9', output: -1, cached: Number.NaN, written: null }, ...many],
          seen: 'nope',
          retired: [],
        },
      },
      history: ['x', null, { tools: 'a', seconds: -3 }, { tools: Number.NaN, seconds: Number.POSITIVE_INFINITY }, { tools: 1e308, seconds: {} }],
    },
  })
  on('agent.list', () => ({ value: [] }))
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)

  const pane = await paneText($)
  const band = await $.ui.mount(BAND as never)
  const bar = await allText(band)
  await band.unmount()
  for (const text of [pane, bar]) {
    expect(text).not.toMatch(BAD)
  }
  expect(bar).toMatch(/~\d+%/)
  // `main` and the newest 99 of the 150 survive (the cap is 100); nothing else counts
  expect(pane).toMatch(/^\s*990 in · 0 out/m)
})

test('a tampered price list in the store prices nothing it should not', async ($, on) => {
  const okRow = { id: 'claude-ok', input: 1, write5m: 1, write1h: 1, cacheRead: 1, output: 1 }
  const { clock } = harness(on, {
    transcript: lines([
      asst('p1', 'claude-ok', usage(1_000_000, 0)),
      asst('p2', 'claude-neg', usage(1_000_000, 0)),
      asst('p3', 'claude-huge', usage(1_000_000, 0)),
      asst('p4', 'claude-nan', usage(1_000_000, 0)),
      asst('p5', 'claude-over', usage(1_000_000, 0)),
      asst('p6', 'claude-long', usage(1_000_000, 0)),
    ]),
    store: {
      prices: {
        fetchedAt: 9e15,
        rows: [
          null,
          5,
          { id: 5, input: 1, write5m: 1, write1h: 1, cacheRead: 1, output: 1 },
          { ...okRow, id: 'claude-neg', input: -5 },
          { ...okRow, id: 'claude-huge', output: 1e9 },
          { ...okRow, id: 'claude-nan', cacheRead: Number.NaN },
          { ...okRow, id: 'claude-over', over: 'big' },
          { ...okRow, id: `claude-${'l'.repeat(120)}` },
          okRow,
        ],
      },
    },
  })
  on('agent.list', () => ({ value: [] }))
  await $.prompt.submit({ text: 'go' } as never)
  await clock.settle()
  await clock.advance(500)
  await stopAgent($, 'h9000000aaaa')
  await clock.settle()

  const pane = await paneText($)
  expect(pane).not.toMatch(BAD)
  // only the whole price row prices anything: $1 for the million tokens of `claude-ok`
  expect(pane).toMatch(/est\. \$1\.00\+/)
})

test('a store that holds the wrong kinds of value everywhere still lets a prompt through', async ($, on) => {
  harness(on, {
    store: {
      'ledger:s1': 'text',
      history: { not: 'a list' },
      prices: { rows: 'x', fetchedAt: 'y' },
      pricesTriedAt: 'never',
    },
  })
  on('agent.list', () => ({ value: [] }))
  await $.prompt.submit({ text: 'go' } as never)
  const band = await $.ui.mount(BAND as never)
  expect(await allText(band)).toMatch(/~\d+%/)
  await band.unmount()
  expect(await paneText($)).not.toMatch(BAD)
})

test('classic.Stop answers at once: the transcripts are read only when the clock moves', async ($, on) => {
  const { clock, reads } = harness(on, { transcript: lines([asst('a', 'claude-unlisted-9', usage(100, 50))]) })
  listed(on, 'h1100000aaaa')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  reads.length = 0

  await stopTurn($)
  expect(reads).toEqual([])
  await clock.advance(1)
  await clock.settle()
  expect(reads).toEqual(['/p/sess/subagents/agent-h1100000aaaa.jsonl'])
})

test('classic.SubagentStop answers at once too', async ($, on) => {
  const { clock, reads } = harness(on, { transcript: lines([asst('a', 'claude-unlisted-9', usage(100, 50))]) })
  on('agent.list', () => ({ value: [] }))
  await $.prompt.submit({ text: 'go' } as never)
  reads.length = 0
  await stopAgent($, 'h1200000aaaa', '/p/a.jsonl')
  expect(reads).toEqual([])
  await clock.advance(1)
  await clock.settle()
  expect(reads).toEqual(['/p/a.jsonl'])
})

test('session.end cancels work a stop event has scheduled', async ($, on) => {
  const { clock, reads } = harness(on, { transcript: lines([asst('a', 'claude-unlisted-9', usage(100, 50))]) })
  listed(on, 'h1300000aaaa')
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  reads.length = 0

  await stopTurn($)
  await stopAgent($, 'h1300000aaaa', '/p/a.jsonl')
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  await clock.advance(10_000)
  await clock.settle()
  expect(reads).toEqual([])
})

test('nothing saves the ledger again after session.end until a session.start', async ($, on) => {
  const memory = new Map<string, unknown>()
  const { clock } = harness(on, { memory })
  on('agent.list', () => ({ value: [] }))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: turnUsage(1000, 500) }
  })
  const step = async () => {
    for await (const _chunk of $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 1 } as never)) {
      // drain
    }
  }
  await $.prompt.submit({ text: 'go' } as never)
  await step()
  await completeTurn($)
  await clock.advance(500)
  expect(memory.has('ledger:s1')).toBe(true)

  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  expect(memory.has('ledger:s1')).toBe(false)

  // a late save, forced or timed, cannot bring the key back
  await $.prompt.submit({ text: 'again' } as never)
  await step()
  await completeTurn($)
  await clock.advance(5000)
  await clock.settle()
  expect(memory.has('ledger:s1')).toBe(false)

  // a new session may save again
  await $.session.start({ cwd: '/work' } as never)
  await step()
  await completeTurn($)
  await clock.advance(500)
  expect(memory.has('ledger:s1')).toBe(true)
})
