import { test, expect, mock } from 'claude-code/testing'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const ROW = { id: 'claude-haiku-5-5', input: 1, write5m: 1.25, write1h: 2, cacheRead: 0.1, output: 5 }
// Five rows: fewer than that is not a price list (see parsePrices); here they are read back from the store.
const ROWS = Array.from({ length: 5 }, (_v, i) => ({ ...ROW, id: `claude-model-${i}` }))

const harness = (on: any, memory: Map<string, unknown>) => {
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
  on('session.id', () => ({ value: 's1' }))
  on('agent.list', () => ({ value: [] }))
  return clock
}

test('the store keeps a 7 day window: older ledgers, prices and fetch times are deleted', async ($, on) => {
  const memory = new Map<string, unknown>([
    ['ledger:eight-days', { at: NOW - 8 * DAY, ledger: {} }],
    ['ledger:six-days', { at: NOW - 6 * DAY, ledger: {} }],
    ['ledger:undated', { ledger: {} }],
    ['ledger:junk', 'not an object'],
    ['ledger:s1', { at: NOW - 30 * DAY, ledger: {} }], // the running session's own copy stays
    ['prices', { fetchedAt: NOW - 8 * DAY, rows: ROWS }],
    ['pricesTriedAt', NOW - 8 * DAY],
    ['history', [{ tools: 3, seconds: 10 }]],
  ])
  const clock = harness(on, memory)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)

  expect(memory.has('ledger:eight-days')).toBe(false)
  expect(memory.has('ledger:undated')).toBe(false)
  expect(memory.has('ledger:junk')).toBe(false)
  expect(memory.has('ledger:six-days')).toBe(true)
  expect(memory.has('ledger:s1')).toBe(true)
  // a week-old price list is gone and the failed refetch brought nothing back
  expect(memory.has('prices')).toBe(false)
  // the old fetch time went too; the attempt just made left a new one
  expect(memory.get('pricesTriedAt')).toBe(NOW)
  // the turn history has no dates and is not part of the window
  expect(memory.has('history')).toBe(true)
})

test('prices younger than the window stay even when they are due a refresh', async ($, on) => {
  const memory = new Map<string, unknown>([
    ['prices', { fetchedAt: NOW - 3 * DAY, rows: ROWS }],
    ['ledger:two-days', { at: NOW - 2 * DAY, ledger: {} }],
  ])
  const clock = harness(on, memory)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)

  expect((memory.get('prices') as { fetchedAt: number } | undefined)?.fetchedAt).toBe(NOW - 3 * DAY)
  expect(memory.has('ledger:two-days')).toBe(true)
})
