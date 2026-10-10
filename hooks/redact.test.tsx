import { test, expect, mock } from 'claude-code/testing'

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

// Each case runs as its own subagent, so the pane's per-agent call list never cuts one off.
// The pane shows the tool name and the hint in two Text pieces: `✓ Tool` and ` hint · time`.
const CASES: { tool: string; input: Record<string, string>; secrets: string[]; hint: RegExp }[] = [
  {
    tool: 'Bash',
    input: { command: 'curl -H "Authorization: Bearer abc123SECRET456" https://x.io/a?token=zzz' },
    secrets: ['abc123SECRET456', 'zzz', 'token='],
    hint: /^ curl -H "Authorization: …" https:\/\/… · /,
  },
  {
    tool: 'Shell',
    input: { command: 'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
    secrets: ['ghp_', 'abcdefghijklmnopqrstuvwxyz'],
    hint: /^ export GITHUB_TOKEN=… · /,
  },
  {
    tool: 'Run',
    input: { command: 'psql postgres://admin:hunter2@db/prod' },
    secrets: ['hunter2', 'admin'],
    hint: /^ psql postgres:\/\/…@db\/prod · /,
  },
  {
    tool: 'Deploy',
    input: { command: 'deploy --api-key sk-ant-api03-AAAABBBBCCCC' },
    secrets: ['sk-ant', 'AAAABBBBCCCC'],
    hint: /^ deploy --api-key … · /,
  },
  { tool: 'Test', input: { command: 'npm test' }, secrets: [], hint: /^ npm test · / },
  { tool: 'Read', input: { file_path: 'src/app.ts' }, secrets: [], hint: /^ src\/app\.ts · / },
  { tool: 'Grep', input: { pattern: 'TodoWrite' }, secrets: [], hint: /^ TodoWrite · / },
]

test('secrets never reach the pane, and plain hints are unchanged', async ($, on) => {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  on('http.fetch', () => ({ value: { status: 503, ok: false, headers: {}, text: '' } }))
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  const agents = CASES.map((_c, i) => ({
    id: `r${i}000000aaaa`,
    description: `case ${i}`,
    type: 'Explore',
    status: 'running',
  }))
  on('agent.list', () => ({ value: agents }) as never)

  await $.prompt.submit({ text: 'go' } as never)
  await clock.advance(500)

  for (const [i, c] of CASES.entries()) {
    await $.tool.call({ tool: c.tool, ...c.input, tool_use_id: `u${i}`, agentId: agents[i]!.id } as never)
  }
  await clock.advance(500)

  const pane = await $.ui.mount(PANE as never)
  for (const c of CASES) {
    expect(await pane.find({ type: 'Text', text: new RegExp(`✓ ${c.tool}\\s*$`) })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: c.hint })).toBeDefined()
    for (const secret of c.secrets) {
      expect(await pane.find({ type: 'Text', text: new RegExp(secret) })).toBeUndefined()
    }
  }
  await pane.unmount()
})
