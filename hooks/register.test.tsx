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
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
  on('agent.list', () => [] as never)
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
      expect(await waiting.find({ type: 'Text', text: /working/ })).toBeDefined()
      expect(await waiting.find({ type: 'Text', text: /0%/ })).toBeUndefined()
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
