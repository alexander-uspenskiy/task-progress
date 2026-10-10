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
      title: 'Agents',
      isFocused: false,
      bodyColumns: 80,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20, total: 1 },
      view: {},
    },
  } as never)
  expect(await pane.find({ type: 'Text', text: /Subagents · 1 total · 1 active/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /Explore \(find hooks\)/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /abcdef12 · running · haiku-5-5 · effort high/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /haiku-5-5 · effort high/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /TodoWrite/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /opus-5-5 · effort xhigh/ })).toBeDefined()
  // model and effort have a colour of their own, apart from the dim line around them
  for (const text of [/^opus-5-5$/, /^effort xhigh$/, /^haiku-5-5$/, /^effort high$/]) {
    const piece = await pane.find({ type: 'Text', text })
    expect(piece?.props?.color).toBe('suggestion')
  }
  expect(await pane.find({ type: 'Text', text: /1 tools · 1\.5k tok · 1\.2k in · 300 out$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /9\.7k tok · 9\.0k in \(4\.0k cached\) · 700 out/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /2 tools · Bash×2/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^\s*10\.2k in \(4\.0k cached\) · 1\.0k out$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^\s*10\.2k in \(4\.0k cached\) · 1\.0k out$/ })).toBeDefined()
  await pane.unmount()

  const band = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', ...BAND } as never)
  expect(await band.find({ type: 'Text', text: /turn 10\.2k in \(4\.0k cached\) · 1\.0k out · session 10\.2k in \(4\.0k cached\)/ })).toBeDefined()
  await band.unmount()

  await $.prompt.submit({ text: 'next' } as never)
  const fresh = await $.ui.mount({ plugin: 'task-progress', surface: 'terminal', ...BAND } as never)
  expect(await fresh.find({ type: 'Text', text: /turn 0 in · 0 out · session 10\.2k in \(4\.0k cached\)/ })).toBeDefined()
  await fresh.unmount()
})

test('a turn whose requests report no usage is still counted from its closing report', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  mock.clock(on)
  mock.store(on)
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })

  await $.prompt.submit({ text: 'go' } as never)
  for await (const _chunk of $.turn.step({ turnId: 'z', index: 0, model: 'm', messageCount: 1 } as never)) {
    // drain
  }
  await $.turn.complete({
    answer: 'ok',
    durationMs: 10,
    isAborted: false,
    turnId: 'z',
    reason: 'answer',
    usage: { model: 'm', input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300, cache_creation_input_tokens: 50 },
  } as never)

  const pane = await $.ui.mount({
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
  } as never)
  expect(await pane.find({ type: 'Text', text: /^\s*450 in \(300 cached\) · 200 out$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /counted: 0\/1 requests · 1 turns/ })).toBeDefined()
  await pane.unmount()
})

const PRICING_MD = [
  '| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |',
  '| :-- | :-- | :-- | :-- | :-- | :-- |',
  '| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |',
  '| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |',
  '| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |',
  '| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.10 / MTok<sup>2</sup> | $10 / MTok |',
  '| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |',
  '| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |',
].join('\n')

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

// One main-loop request on `model`: 1000 fresh, 100000 cached, 2000 written, 500 out.
const spend = async ($: any, model: string) => {
  for await (const _chunk of $.turn.step({ turnId: 'p', index: 0, model, messageCount: 1 })) {
    // drain
  }
}

const harness = (on: any, http: () => unknown, model: string) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('http.fetch', http)
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.step', async function* (_$: any, e: any) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model, input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100000, cache_creation_input_tokens: 2000 },
    }
  })
}

test('with a price it shows an estimated cost, dated model ids and tiers included', async ($, on) => {
  harness(on, () => ({ value: { status: 200, ok: true, headers: {}, text: PRICING_MD } }), 'claude-opus-5-5-20260101')
  await $.prompt.submit({ text: 'go' } as never)
  await spend($, 'claude-opus-5-5-20260101')

  // (1000*4 + 2000*5 + 100000*0.2 + 500*20) / 1e6 = $0.044
  const pane = await $.ui.mount(PANE as never)
  expect(await pane.find({ type: 'Text', text: /^\s*103\.0k in \(100\.0k cached\) · 500 out · est\. \$0\.04$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /6 prices/ })).toBeDefined()
  // the estimated amount stands out in bold, wherever it is shown
  const est = await pane.find({ type: 'Text', text: /^est\. \$0\.04$/ })
  expect(est?.props?.bold).toBe(true)
  await pane.unmount()
})

test('a model whose price is not on the page is left out, with no estimate', async ($, on) => {
  harness(on, () => ({ value: { status: 200, ok: true, headers: {}, text: PRICING_MD } }), 'claude-unlisted-9')
  await $.prompt.submit({ text: 'go' } as never)
  await spend($, 'claude-unlisted-9')

  const pane = await $.ui.mount(PANE as never)
  expect(await pane.find({ type: 'Text', text: /^\s*103\.0k in \(100\.0k cached\) · 500 out$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /est\./ })).toBeUndefined()
  await pane.unmount()
})

test('when the prices cannot be fetched nothing is estimated and nothing breaks', async ($, on) => {
  harness(on, () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }), 'claude-opus-5-5')
  await $.prompt.submit({ text: 'go' } as never)
  await spend($, 'claude-opus-5-5')

  const pane = await $.ui.mount(PANE as never)
  expect(await pane.find({ type: 'Text', text: /^\s*103\.0k in \(100\.0k cached\) · 500 out$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /est\./ })).toBeUndefined()
  expect(await pane.find({ type: 'Text', text: /no prices/ })).toBeDefined()
  await pane.unmount()
})

// The model table exactly as Anthropic's pricing page published it (links, footnote marks, notes and all).
const REAL_PRICING_MD = "| Model                                                                                                                                | Base input tokens     | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens          |\n| Claude Fable 5.1                                                                                                                     | $10 / MTok            | $12.50 / MTok   | $20 / MTok      | $0.25 / MTok<sup>1</sup> | $50 / MTok             |\n| Claude Mythos 5.1 ([limited availability](https://support.claude.com/en/articles/14604842))                                          | $10 / MTok            | $12.50 / MTok   | $20 / MTok      | $0.25 / MTok<sup>1</sup> | $50 / MTok             |\n| Claude Fable 5                                                                                                                       | $10 / MTok            | $12.50 / MTok   | $20 / MTok      | $1 / MTok                | $50 / MTok             |\n| Claude Mythos 5 ([limited availability](https://support.claude.com/en/articles/14604842))                                            | $10 / MTok            | $12.50 / MTok   | $20 / MTok      | $1 / MTok                | $50 / MTok             |\n| Claude Opus 5.5                                                                                                                      | $4 / MTok             | $5 / MTok       | $8 / MTok       | $0.20 / MTok<sup>2</sup> | $20 / MTok             |\n| Claude Opus 5                                                                                                                        | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $25 / MTok             |\n| Claude Opus 4.8                                                                                                                      | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $25 / MTok             |\n| Claude Opus 4.7                                                                                                                      | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $25 / MTok             |\n| Claude Opus 4.6                                                                                                                      | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $25 / MTok             |\n| Claude Opus 4.5                                                                                                                      | $5 / MTok             | $6.25 / MTok    | $10 / MTok      | $0.50 / MTok             | $25 / MTok             |\n| Claude Opus 4.1 ([retired, except on Bedrock and Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $15 / MTok            | $18.75 / MTok   | $30 / MTok      | $1.50 / MTok             | $75 / MTok             |\n| Claude Opus 4 ([retired, except on Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations))               | $15 / MTok            | $18.75 / MTok   | $30 / MTok      | $1.50 / MTok             | $75 / MTok             |\n| Claude Sonnet 5.5                                                                                                                    | $2 / MTok             | $2.50 / MTok    | $4 / MTok       | $0.10 / MTok<sup>2</sup> | $10 / MTok             |\n| Claude Sonnet 5                                                                                                                      | $2 / MTok<sup>3</sup> | $2.50 / MTok    | $4 / MTok       | $0.20 / MTok             | $10 / MTok<sup>3</sup> |\n| Claude Sonnet 4.6                                                                                                                    | $3 / MTok             | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok             | $15 / MTok             |\n| Claude Sonnet 4.5                                                                                                                    | $3 / MTok             | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok             | $15 / MTok             |\n| Claude Sonnet 4 ([retired, except on Bedrock and Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations)) | $3 / MTok             | $3.75 / MTok    | $6 / MTok       | $0.30 / MTok             | $15 / MTok             |\n| Claude Haiku 5.5 (for prompts up to 100,000 tokens)                                                                                  | $0.10 / MTok          | $0.125 / MTok   | $0.20 / MTok    | $0.01 / MTok             | $0.50 / MTok           |\n| Claude Haiku 5.5 (for prompts over 100,000 tokens)                                                                                   | $0.50 / MTok          | $0.625 / MTok   | $1 / MTok       | $0.05 / MTok             | $2.50 / MTok           |\n| Claude Haiku 4.5                                                                                                                     | $1 / MTok             | $1.25 / MTok    | $2 / MTok       | $0.10 / MTok             | $5 / MTok              |\n| Claude Haiku 3.5 ([retired, except on Google Cloud](https://platform.claude.com/docs/en/about-claude/model-deprecations))            | $0.80 / MTok          | $1 / MTok       | $1.60 / MTok    | $0.08 / MTok             | $4 / MTok              |"

test('the real pricing page layout parses, and an Opus 5.5 request is priced from it', async ($, on) => {
  harness(on, () => ({ value: { status: 200, ok: true, headers: {}, text: REAL_PRICING_MD } }), 'claude-opus-5-5')
  await $.prompt.submit({ text: 'go' } as never)
  await spend($, 'claude-opus-5-5')

  const pane = await $.ui.mount(PANE as never)
  expect(await pane.find({ type: 'Text', text: /21 prices/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /500 out · est\. \$0\.04$/ })).toBeDefined()
  await pane.unmount()
})

test('each agent type gets its own small icon next to its status', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('agent.list', () =>
    ({
      value: [
        { id: 'a1000000aaaa', description: 'find hooks', type: 'Explore', status: 'running' },
        { id: 'a2000000aaaa', description: 'misc work', type: 'general-purpose', status: 'completed' },
        { id: 'a3000000aaaa', description: 'design it', type: 'Plan', status: 'pending' },
        { id: 'a4000000aaaa', description: 'check diff', type: 'code-reviewer', status: 'failed' },
        { id: 'a5000000aaaa', description: 'write it', type: 'coder', status: 'idle' },
        { id: 'a6000000aaaa', description: 'unknown', type: 'mystery', status: 'waiting' },
        { id: 'a7000000aaaa', description: 'runs the team', type: 'coordinator', status: 'running' },
        { id: 'a8000000aaaa', description: 'splits the work', type: 'orchestrator', status: 'completed' },
      ],
    }) as never,
  )

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)

  // a tall pane, so all eight cards fit
  const pane = await $.ui.mount({ ...PANE, viewport: { columns: 80, rows: 80 } } as never)
  expect(await pane.find({ type: 'Text', text: /◐ 🔍/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /● 👷/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /○ 🔬/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /✗ 🧐/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /◌ 💻/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /◔ 🤖/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /◐ 🧭/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /● 🎼/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /▌ 🧠 Main agent/ })).toBeDefined()
  await pane.unmount()

  // a short pane cannot fit them all: it says how many it left out
  const short = await $.ui.mount({ ...PANE, viewport: { columns: 80, rows: 16 } } as never)
  expect(await short.find({ type: 'Text', text: /older agents? not shown/ })).toBeDefined()
  await short.unmount()
})

test('a finished subagent moves into the history with the tokens it spent', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('turn.step', async function* (_$, e) {
    const usage = e.agentId
      ? { model: 'claude-unlisted-9', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100000, cache_creation_input_tokens: 0 }
      : null
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  let listed: unknown[] = [{ id: 'h1000000aaaa', description: 'find hooks', type: 'Explore', status: 'running' }]
  on('agent.list', () => ({ value: listed }) as never)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  for await (const _chunk of $.turn.step({
    turnId: 't1',
    index: 0,
    model: 'claude-unlisted-9',
    messageCount: 1,
    agentId: 'h1000000aaaa',
  } as never)) {
    // drain
  }

  // still running: it is an active card and there is no history yet
  const running = await $.ui.mount({ ...PANE, viewport: { columns: 80, rows: 60 } } as never)
  expect(await running.find({ type: 'Text', text: /Explore \(find hooks\)/ })).toBeDefined()
  expect(await running.find({ type: 'Text', text: /History/ })).toBeUndefined()
  await running.unmount()

  // it leaves the agent list, so it counts as finished and moves into the history
  listed = []
  await clock.advance(5000)

  const done = await $.ui.mount({ ...PANE, viewport: { columns: 80, rows: 80 } } as never)
  expect(await done.find({ type: 'Text', text: /^History · 1 of 1 finished · 101\.5k tok$/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: /Explore · 101\.5k tok · 0 tools · \d+s · find hooks/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: /● 🔍/ })).toBeDefined()
  // a completed agent's marker is gray in the history, not green
  const marker = await done.find({ type: 'Text', text: /^● 🔍\s*$/ })
  expect(marker?.props?.color).toBe('inactive')
  expect(await done.find({ type: 'Text', text: /Explore \(find hooks\)/ })).toBeUndefined()
  await done.unmount()
})
