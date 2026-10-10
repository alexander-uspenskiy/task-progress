import { test, expect, mock } from 'claude-code/testing'

const NOW = 1_800_000_000_000

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
} as const

const row = (name: string, input: string, output: string) =>
  `| Claude ${name} | ${input} / MTok | $1 / MTok | $2 / MTok | $0.1 / MTok | ${output} / MTok |`

const SANE_ROWS = [
  row('Opus 5.5', '$4', '$20'),
  row('Opus 5', '$5', '$25'),
  row('Sonnet 5.5', '$2', '$10'),
  row('Sonnet 5', '$2', '$10'),
  row('Haiku 5.5', '$0.10', '$0.50'),
]

const page = (text: string) => () => ({ value: { status: 200, ok: true, headers: {}, text } })

// The mod with a stubbed network: `http` answers every price fetch.
const harness = (on: any, http: () => unknown) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const seen = { fetches: 0, lists: 0 }
  on('http.fetch', () => {
    seen.fetches++
    return http()
  })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('command.register', () => ({ value: undefined }))
  on('session.end', () => ({ sessionId: 's' }))
  on('session.start', () => ({ cwd: '/work' }))
  return { clock, seen }
}

const listNone = (on: any, seen: { lists: number }) =>
  on('agent.list', () => {
    seen.lists++
    return { value: [] }
  })

const paneText = async ($: any, text: RegExp) => {
  const pane = await $.ui.mount(PANE as never)
  const found = await pane.find({ type: 'Text', text })
  await pane.unmount()
  return found
}

const complete = ($: any) =>
  $.turn.complete({
    answer: 'ok',
    durationMs: 10,
    isAborted: false,
    turnId: 'm',
    reason: 'answer',
  } as never)

test('a fetch that never answers does not block prompt.submit, and prices stay unknown', async ($, on) => {
  const { clock, seen } = harness(on, () => new Promise(() => {}))
  listNone(on, seen)

  // returns at once: the fetch runs from a timer, not inside the hook
  await $.session.start({ cwd: '/work' } as never)
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(1)
  expect(seen.fetches).toBe(1)

  // past the timeout the stalled fetch is given up on
  await clock.advance(9000)
  expect(await paneText($, /no prices/)).toBeDefined()

  // and it is not retried within the hour
  await $.prompt.submit({ text: 'again' } as never)
  await clock.advance(1000)
  expect(seen.fetches).toBe(1)
  expect(await paneText($, /no prices/)).toBeDefined()
})

test('a fetch that rejects changes nothing and breaks nothing', async ($, on) => {
  const { clock, seen } = harness(on, () => Promise.reject(new Error('offline')))
  listNone(on, seen)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(1000)
  expect(seen.fetches).toBe(1)
  expect(await paneText($, /no prices/)).toBeDefined()
})

test('a hostile page yields no prices and does not hang', async ($, on) => {
  const huge = `| Claude Huge | $1 / MTok | $1 | $1 | $1 | $1 | ${'x'.repeat(2_000_000)}`
  const brackets = `| Claude ${'['.repeat(100_000)} | $1 | $1 | $1 | $1 | $1 |`
  const manyBrackets = Array.from({ length: 400 }, () => `| Claude ${'['.repeat(900)} | $1 | $1 | $1 | $1 | $1 |`)
  const parens = `| Claude ${'(['.repeat(900)} | $1 | $1 | $1 | $1 | $1 |`
  const links = `| Claude ${'[a]('.repeat(300)} | $1 | $1 | $1 | $1 | $1 |`
  const digits = '9'.repeat(400)
  const infinite = `| Claude Inf | $${digits} / MTok | $1 | $1 | $1 | $1 |`
  const exact = `| Claude Exact | $1e400 | $1 | $1 | $1 | $1 |`
  const costly = `| Claude Costly | $5000 / MTok | $1 | $1 | $1 | $1 |`
  const hostile = [huge, brackets, ...manyBrackets, parens, links, infinite, exact, costly, ...SANE_ROWS.slice(0, 4)].join('\n')
  const { clock, seen } = harness(on, page(hostile))
  listNone(on, seen)

  const started = Date.now()
  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(1000)
  expect(Date.now() - started).toBeLessThan(5000)
  // fewer than five sane rows: the page is not trusted at all
  expect(await paneText($, /no prices/)).toBeDefined()
})

test('only sane rows of a hostile page are kept, within the caps', async ($, on) => {
  const insane = [
    `| Claude Inf | $${'9'.repeat(400)} / MTok | $1 | $1 | $1 | $1 |`,
    `| Claude Costly | $1000.5 / MTok | $1 | $1 | $1 | $1 |`,
    `| Claude Long | $1 | $1 | $1 | $1 | $1 | ${'y'.repeat(3000)} |`,
    `| Claude ${'['.repeat(100_000)} | $1 | $1 | $1 | $1 | $1 |`,
  ]
  const { clock, seen } = harness(on, page([...insane, ...SANE_ROWS, row('Edge', '$1000', '$0')].join('\n')))
  listNone(on, seen)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(1000)
  // five sane rows plus the one at the edge of the range (1000 and 0 are allowed)
  expect(await paneText($, /6 prices/)).toBeDefined()
})

test('at most 200 rows are read from a page', async ($, on) => {
  const many = Array.from({ length: 1000 }, (_, i) => row(`Model ${i}`, '$1', '$2'))
  const { clock, seen } = harness(on, page(many.join('\n')))
  listNone(on, seen)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(1000)
  expect(await paneText($, /200 prices/)).toBeDefined()
})

test('only the first 400k characters of a page are read', async ($, on) => {
  const padding = `${'z'.repeat(1000)}\n`.repeat(400)
  const { clock, seen } = harness(on, page([...SANE_ROWS.slice(0, 4), padding, row('Late', '$1', '$2')].join('\n')))
  listNone(on, seen)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(1000)
  // the fifth row lies past the cap, so there are too few to trust
  expect(await paneText($, /no prices/)).toBeDefined()
})

test('after the run ends the tick stops polling', async ($, on) => {
  const { clock, seen } = harness(on, page(''))
  listNone(on, seen)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(2000)
  expect(seen.lists).toBeGreaterThan(2)

  await complete($)
  const after = seen.lists
  await clock.advance(5000)
  expect(seen.lists).toBe(after)

  // a new prompt starts it again
  await $.prompt.submit({ text: 'next' } as never)
  await clock.advance(2000)
  expect(seen.lists).toBeGreaterThan(after + 2)
})

test('session.end cancels the tick', async ($, on) => {
  const { clock, seen } = harness(on, page(''))
  listNone(on, seen)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(1000)
  expect(seen.lists).toBeGreaterThan(0)

  await $.session.end({ reason: 'other', sessionId: 's', resume: { id: 's' } } as never)
  const after = seen.lists
  await clock.advance(5000)
  expect(seen.lists).toBe(after)
})

test('a rejecting agent.list leaves no unhandled rejection', async ($, on) => {
  const { clock } = harness(on, page(''))
  let lists = 0
  on('agent.list', () => {
    lists++
    throw new Error('agent list is down')
  })
  // a rejection nobody handles fails the run of the test itself; the listener
  // (where the sandbox has one) names it
  const unhandled: unknown[] = []
  const trap = (event: { reason?: unknown }) => unhandled.push(event.reason ?? event)
  const target = globalThis as unknown as {
    addEventListener?: (type: string, fn: typeof trap) => void
    removeEventListener?: (type: string, fn: typeof trap) => void
  }
  target.addEventListener?.('unhandledrejection', trap)
  try {
    await $.prompt.submit({ text: 'go' } as never)
    await clock.advance(2000)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(lists).toBeGreaterThan(0)
    expect(unhandled).toEqual([])
  } finally {
    target.removeEventListener?.('unhandledrejection', trap)
  }
})
