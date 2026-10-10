import { test, expect, mock } from 'claude-code/testing'

// Text that is not ours must never carry a control character to the screen.
// The characters are built at run time from their code points.
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const NEL = String.fromCharCode(0x85)
const CSI8 = String.fromCharCode(0x9b)
const LS = String.fromCharCode(0x2028)
const RLO = String.fromCharCode(0x202e)
const ISOLATE = String.fromCharCode(0x2066)
const ZWSP = String.fromCharCode(0x200b)
const ZWJ = String.fromCharCode(0x200d)
const OSC = `${ESC}]0;pwned${BEL}`
const CSI = `${ESC}[31m`
const CONTROL = /[\x00-\x1f\x7f-\x9f]/
const INVISIBLE = new RegExp(`[${LS}${RLO}${ISOLATE}${ZWSP}${ZWJ}]`)

const BAND = {
  plugin: 'task-progress',
  surface: 'terminal',
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
  viewport: { columns: 120, rows: 80 },
  props: {
    title: 'Agents',
    isFocused: false,
    bodyColumns: 120,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60, total: 1 },
    view: {},
  },
} as const

const texts = async (ui: any) => ((await ui.findAll({ type: 'Text' })) as { text: string }[]).map(t => t.text)

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
  on('session.id', () => ({ value: 's1' }))
  on('classic.SubagentStop', () => ({}))
  on('turn.step', async function* (_$: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return clock
}

test('agent names, tool names, hints, models and errors reach the screen without control characters', async ($, on) => {
  const clock = harness(on)
  const id = 'z1000000aaaa'
  const junk = `claude-haiku${OSC}-5-5${ZWSP}${CSI8} <b>${'z'.repeat(300)}`
  on('agent.list', () => ({
    value: [
      {
        id,
        description: `find${OSC} hooks${CSI} now${RLO}${ZWSP}`,
        name: `scout${RLO}${ZWSP}${ISOLATE}x${ESC}[2J`,
        type: 'Explore',
        status: 'running',
      },
      // nothing but control characters: the type is what is left to show
      { id: 'z2000000aaaa', description: `${ESC}${BEL}`, name: `${NEL}`, type: 'Plan', status: 'completed' },
    ],
  }))
  on('tool.call', () => ({ result: { text: 'ok' } }))
  on('fs.read', () => ({ deny: `no such file${ESC}[2J${OSC}` }))

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  for await (const _chunk of $.turn.step({
    turnId: 'x',
    index: 0,
    model: junk,
    effort: `high${CSI}`,
    messageCount: 1,
    agentId: id,
  } as never)) {
    // drain the stream: the hook runs as the stream is read
  }
  await $.tool.call({
    tool: `Bash${CSI}`,
    command: `echo${OSC} hi${NEL}there${LS}you`,
    tool_use_id: 'u1',
    agentId: id,
  } as never)
  await $.tool.call({ tool: 'Write', file_path: `src/${ESC}[1mapp.ts`, tool_use_id: 'u2', agentId: id } as never)
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: `ship${CSI} it${LS}now${BEL}${RLO}${ZWSP}`, status: 'in_progress', activeForm: 'shipping' },
      { content: `${ESC}${BEL}`, status: 'pending', activeForm: 'x' },
    ],
    tool_use_id: 'u3',
  } as never)
  await $.classic.SubagentStop({
    agent_id: 'z2000000aaaa',
    agent_type: 'Plan',
    stop_hook_active: false,
    agent_transcript_path: '/missing',
  } as never)
  await clock.advance(500)

  const pane = await $.ui.mount(PANE as never)
  const band = await $.ui.mount(BAND as never)
  const paneText = await texts(pane)
  const bandText = await texts(band)
  await pane.unmount()
  await band.unmount()

  expect(paneText.length).toBeGreaterThan(5)
  expect(bandText.length).toBeGreaterThan(2)
  for (const t of [...paneText, ...bandText]) {
    expect(CONTROL.test(t), `control character in ${JSON.stringify(t)}`).toBe(false)
    expect(INVISIBLE.test(t), `invisible character in ${JSON.stringify(t)}`).toBe(false)
  }

  // the readable parts remain
  expect(paneText.some(t => /scoutx.*find\]0;pwned hooks\[31m now/.test(t)), `${paneText.join(" | ")}`).toBe(true)
  expect(paneText.some(t => /✓ Bash\[31m/.test(t)), `${paneText.join(" | ")}`).toBe(true)
  expect(paneText.some(t => /^ echo\]0;pwned hi there you · /.test(t)), `${paneText.join(" | ")}`).toBe(true)
  expect(paneText.some(t => /^ src\/\[1mapp\.ts · /.test(t)), `${paneText.join(" | ")}`).toBe(true)
  // the model keeps its own characters only, at most 80 of them
  const setup = paneText.find(t => /haiku/.test(t) && /effort/.test(t)) ?? ''
  expect(setup).toMatch(/haiku/)
  expect(setup).toMatch(/effort high\[31m/)
  expect(setup).not.toMatch(/[<>;]/)
  expect(setup).not.toMatch(/z{81}/)
  // an agent whose label is all control characters falls back to its type
  expect(paneText.some(t => /Plan/.test(t)), `${paneText.join(" | ")}`).toBe(true)
  // the footer says there was an error, cleanly
  expect(paneText.some(t => /error: transcript:.*no such file/.test(t)), `${paneText.join(" | ")}`).toBe(true)
  // the band shows the task in progress
  expect(bandText.some(t => /ship\[31m it now/.test(t)), `${bandText.join(" | ")}`).toBe(true)
})

test('task subjects are cleaned when they enter TaskCreate and TaskUpdate', async ($, on) => {
  const clock = harness(on)
  on('agent.list', () => ({ value: [] }))
  let n = 0
  on('tool.call', (_$: any, e: any) => ({
    result: e.tool === 'TaskCreate' ? { task: { id: String(++n), subject: e.subject } } : { success: true },
  }))

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)
  await $.tool.call({ tool: 'TaskCreate', subject: `plan${OSC} it${RLO}`, description: 'a' } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: `build${CSI}${LS}it`, description: 'b' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', subject: `build${ESC}[2K${ZWSP} it now`, status: 'in_progress' } as never)

  const band = await $.ui.mount(BAND as never)
  const bandText = await texts(band)
  await band.unmount()
  expect(bandText.length).toBeGreaterThan(2)
  for (const t of bandText) expect(CONTROL.test(t), `control character in ${JSON.stringify(t)}`).toBe(false)
  // the first task that is in progress is the label
  expect(bandText.some(t => /plan\]0;pwned it/.test(t)), `${bandText.join(" | ")}`).toBe(true)

  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  const again = await $.ui.mount(BAND as never)
  const label = await texts(again)
  await again.unmount()
  expect(label.some(t => /build\[2K it now/.test(t)), `${label.join(" | ")}`).toBe(true)
  for (const t of label) expect(CONTROL.test(t)).toBe(false)
})

test('a model string full of junk is cut down to its own characters at spawn', async ($, on) => {
  const clock = harness(on)
  const id = 'z3000000aaaa'
  on('agent.spawn', () => ({ model: `claude-sonnet${OSC}-5-5-20260101${ZWJ}${'q'.repeat(200)}`, agentId: id }))
  on('agent.list', () => ({
    value: [{ id, description: 'worker', type: 'general-purpose', status: 'running' }],
  }))
  on('tool.call', () => ({ result: { text: 'ok' } }))

  await $.prompt.submit({ text: 'go' } as never)
  await $.agent.spawn({ prompt: 'do it' } as never)
  await clock.advance(500)
  const pane = await $.ui.mount(PANE as never)
  const paneText = await texts(pane)
  await pane.unmount()
  for (const t of paneText) expect(CONTROL.test(t), `control character in ${JSON.stringify(t)}`).toBe(false)
  const setup = paneText.find(t => /sonnet/.test(t)) ?? ''
  expect(setup).toMatch(/sonnet\]0pwned-5-5-20260101q+/)
  expect(setup).not.toMatch(/q{81}/)
})
