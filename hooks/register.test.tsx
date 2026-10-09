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

test('band is hidden until a task starts, then follows TaskCreate/TaskUpdate', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  mock.clock(on)
  mock.store(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  let n = 0
  on('tool.call', (_$, e) =>
    ({
      result:
        e.tool === 'TaskCreate'
          ? { task: { id: String(++n), subject: (e as { subject: string }).subject } }
          : { success: true },
    }) as never,
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    if (surface === 'terminal') {
      const idle = await $.ui.mount({ plugin: 'task-progress', surface, ...BAND } as never)
      expect(await idle.find({ type: 'Text', text: /%/ })).toBeUndefined()
      await idle.unmount()
    }

    await $.prompt.submit({ text: 'do the thing' } as never)
    if (surface === 'terminal') {
      const waiting = await $.ui.mount({ plugin: 'task-progress', surface, ...BAND } as never)
      expect(await waiting.find({ type: 'Text', text: /~\d+%/ })).toBeDefined()
      await waiting.unmount()
    }

    n = 0
    await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' } as never)
    await $.tool.call({ tool: 'TaskCreate', subject: 'b', description: 'b' } as never)
    await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)

    const ui = await $.ui.mount({ plugin: 'task-progress', surface, ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /50%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('without a task list the estimate climbs with tool calls and stops short of 100%', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  mock.clock(on)
  mock.store(on, { history: [{ tools: 4, seconds: 30 }] })
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)

  await $.prompt.submit({ text: 'go' } as never)
  const percent = async () => {
    const ui = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', ...BAND } as never)
    const found = await ui.find({ type: 'Text', text: /~\d+%/ })
    await ui.unmount()
    return Number(/~(\d+)%/.exec(found?.text ?? '')?.[1])
  }

  const before = await percent()
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'true' } as never)
  const mid = await percent()
  for (let i = 0; i < 40; i++) await $.tool.call({ tool: 'Bash', command: 'true' } as never)
  const late = await percent()

  expect(mid).toBeGreaterThan(before)
  expect(late).toBeLessThanOrEqual(95)
})

test('the pane lists a subagent with its tools, status and token usage', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on)
  mock.store(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  on('turn.step', async function* (_$, e) {
    const usage = e.agentId
      ? { model: 'm', input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
      : { model: 'm', input_tokens: 5000, output_tokens: 700, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  on('agent.list', () =>
    ({
      value: [{ id: 'abcdef123456', description: 'find hooks', type: 'Explore', status: 'running' }],
    }) as never,
  )

  await $.prompt.submit({ text: 'go' } as never)
  for await (const _chunk of $.turn.step({
    turnId: 'x',
    index: 0,
    model: 'claude-haiku-5-5-20260101',
    effort: 'high',
    messageCount: 1,
    agentId: 'abcdef123456',
  } as never)) {
    // drain the stream: the hook runs as the stream is read
  }
  for await (const _chunk of $.turn.step({
    turnId: 'm',
    index: 0,
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    messageCount: 1,
  } as never)) {
    // drain
  }
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'm1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'm2' } as never)
  await $.turn.complete({
    answer: 'ok',
    durationMs: 10,
    isAborted: false,
    turnId: 'm',
    reason: 'answer',
    usage: { model: 'm', input_tokens: 5000, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never)
  await $.tool.call({
    tool: 'Grep',
    pattern: 'TodoWrite',
    tool_use_id: 't1',
    agentId: 'abcdef123456',
  } as never)
  await $.turn.complete({
    answer: 'done',
    durationMs: 10,
    isAborted: false,
    turnId: 'x',
    reason: 'answer',
    agentId: 'abcdef123456',
    usage: { model: 'm', input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as never)
  await clock.advance(500)

  const pane = await $.ui.mount({
    plugin: 'task-progress',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'task-agents',
    props: {
      title: 'Subagents',
      isFocused: false,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20, total: 1 },
      view: {},
    },
  } as never)
  expect(await pane.find({ type: 'Text', text: /Explore \(find hooks\)/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /abcdef12 · haiku-5-5 · effort high · running · 1 tools · 1\.5k tok/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /haiku-5-5 · effort high/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /TodoWrite/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /opus-5-5 · effort xhigh · 2 tools · 5\.7k tok \(5\.0k in \/ 700 out \/ 4\.0k cached\)/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Bash×2/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Session \(all agents\) · 6\.2k in · 1\.0k out · 4\.0k cached/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /This turn · 6\.2k in · 1\.0k out · 4\.0k cached/ })).toBeDefined()
  await pane.unmount()

  const band = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', ...BAND } as never)
  expect(await band.find({ type: 'Text', text: /turn 6\.2k in · 1\.0k out · 4\.0k cached · session 6\.2k in/ })).toBeDefined()
  await band.unmount()

  await $.prompt.submit({ text: 'next' } as never)
  const fresh = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', ...BAND } as never)
  expect(await fresh.find({ type: 'Text', text: /turn 0 in · 0 out · 0 cached · session 6\.2k in/ })).toBeDefined()
  await fresh.unmount()
})
