import { test, expect, mock } from 'claude-code/testing'

const pane = (bodyColumns: unknown) =>
  ({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'task-agents',
    props: {
      title: 'Agents',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20, total: 1 },
      view: {},
    },
    viewport: { columns: 120, rows: 80 },
  }) as never

const texts = async (ui: any) => ((await ui.findAll({ type: 'Text' })) as { text: string }[]).map(t => t.text)

// Both of the opening calls ask for the narrow dock; a long hint, a long label and
// a priced model give every kind of line something to break.
const setup = async ($: any, on: any) => {
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }) as never)
  const opened: { id: string; columns?: number }[] = []
  on('ui.open', (_$: any, e: any) => {
    opened.push({ id: e.id, columns: e.columns })
    return { value: { isPlaced: true } } as never
  })
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('turn.step', async function* (_$: any, e: any) {
    const usage = {
      model: 'claude-unlisted-9',
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 298_000,
      cache_creation_input_tokens: 0,
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('agent.list', () =>
    ({
      value: [
        { id: 'abcdef123456', description: 'a rather long description of the job', type: 'Explore', status: 'running' },
      ],
    }) as never,
  )
  await $.prompt.submit({ text: 'go' } as never)
  for (const agentId of ['abcdef123456', undefined]) {
    for await (const _chunk of $.turn.step({
      turnId: agentId ?? 'm',
      index: 0,
      model: 'claude-unlisted-9',
      effort: 'high',
      messageCount: 1,
      agentId,
    } as never)) {
      // drain
    }
  }
  await $.tool.call({
    tool: 'Read',
    file_path: '/a/very/long/path/to/some/deeply/nested/directory/file.ts',
    tool_use_id: 'r1',
    agentId: 'abcdef123456',
  } as never)
  await clock.advance(500)
  return opened
}

test('the pane asks for a narrow dock and every line fits the width it gets', async ($, on) => {
  const opened = await setup($, on)
  expect(opened.length).toBeGreaterThan(0)
  for (const o of opened) expect(o.columns).toBe(52)

  for (const width of [30, 40, 52, 80]) {
    const ui = await $.ui.mount(pane(width))
    const all = await texts(ui)
    expect(all.length).toBeGreaterThan(5)
    for (const t of all) {
      // nothing is wider than the pane, but a part that is wider on its own (a long label) is cut at the edge
      if (!/^\s*\(a rather/.test(t)) expect([...t].length, `${width}: ${JSON.stringify(t)}`).toBeLessThanOrEqual(width)
    }
    await ui.unmount()
  }
})

test('a narrow pane breaks a line between its parts, never inside a figure', async ($, on) => {
  await setup($, on)

  const wide = await $.ui.mount(pane(100))
  expect(await wide.find({ type: 'Text', text: /^\s*299\.5k tok · 299\.2k in \(298\.0k cached\) · 300 out$/ })).toBeDefined()
  await wide.unmount()

  const narrow = await $.ui.mount(pane(30))
  const all = await texts(narrow)
  // the same figures, on two lines
  expect(all.some(t => /^\s*299\.2k in \(298\.0k cached\)$/.test(t))).toBe(true)
  expect(all.some(t => /^\s*300 out$/.test(t))).toBe(true)
  // the label no longer fits beside the name, so it moves under it
  expect(all.some(t => /^\s*\(a rather long description of the job\)$/.test(t)), all.join(' | ')).toBe(true)
  await narrow.unmount()
})

test('a long hint is cut so the time of the call stays visible', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount(pane(40))
  const all = await texts(ui)
  const hint = all.find(t => /^ .*…/.test(t) && /· \d+ms$|· \d+\.\ds$|· running$/.test(t))
  expect(hint, all.join(' | ')).toBeDefined()
  await ui.unmount()
})

test('a width the engine did not report falls back to the narrow default', async ($, on) => {
  await setup($, on)
  for (const bad of [undefined, 0, -5, Number.NaN, '80']) {
    const ui = await $.ui.mount(pane(bad))
    for (const t of await texts(ui)) expect([...t].length).toBeLessThanOrEqual(52)
    await ui.unmount()
  }
})
