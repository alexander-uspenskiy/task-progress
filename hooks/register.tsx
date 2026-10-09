import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Run, Todo } from '../types'

const PANE = 'task-agents'
const SEGMENTS = 20
const TICK_MS = 400
const TASK_HINT =
  'The user has a progress bar above the prompt that follows your task list. ' +
  'For work with three or more steps, create the steps first with TaskCreate ' +
  '(one short subject each), mark each in_progress when you start it and ' +
  'completed when it is done with TaskUpdate, so the bar shows real progress.'

const todos = atom({ plugin: 'task-progress', key: 'todos' } as const, [])
const agents = atom({ plugin: 'task-progress', key: 'agents' } as const, [])
const run = atom({ plugin: 'task-progress', key: 'run' } as const, {
  startedAt: 0,
  now: 0,
  isActive: false,
  tools: 0,
})

const ICON: Record<string, string> = {
  pending: '○',
  running: '◐',
  waiting: '◔',
  idle: '◌',
  completed: '●',
  failed: '✗',
  killed: '✗',
}
// Theme keys, not hex: the engine resolves them against the person's theme
// (dark, light, auto), so the bar re-colours itself when the theme switches.
//   key       dark theme        light theme       used for
//   claude    coral on black    coral on white    bar fill, percent, running
//   subtle    dark grey         light grey        bar track
//   text      near-white        near-black        counts
//   inactive  mid grey          mid grey          elapsed time, labels
//   success   green             green             a finished bar, completed
//   warning   amber             amber             waiting
//   error     red               red               failed
const PALETTE = {
  fill: 'claude',
  track: 'subtle',
  trail: 'promptBorder',
  text: 'text',
  muted: 'inactive',
  done: 'success',
}
const COLOR: Record<string, string> = {
  running: 'claude',
  waiting: 'warning',
  completed: 'success',
  failed: 'error',
  killed: 'error',
}
const FINISHED = ['completed', 'failed', 'killed']

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Todos drive the bar when the model keeps a list; otherwise subagents do.
const measure = (list: Todo[], rows: AgentRow[]) => {
  if (list.length > 0) {
    const done = list.filter(t => t.status === 'completed').length
    const current = list.find(t => t.status === 'in_progress')
    return { done, total: list.length, label: current?.content ?? 'tasks' }
  }
  const done = rows.filter(a => FINISHED.includes(a.status)).length
  return { done, total: rows.length, label: rows.length > 0 ? 'subagents' : '' }
}

async function refresh($: EngineInterface) {
  const list = await $.agent.list()
  const rows: AgentRow[] = list.map(a => ({
    id: a.id,
    label: a.description || a.name || a.type,
    type: a.type,
    status: a.status,
  }))
  const now = await $.clock.now()
  await update($, agents, () => rows)
  await update($, run, r => ({ ...r, now }))
}

export const register: Register = on => {
  let tick: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-agents',
      description: 'Open the subagents pane (status of every subagent)',
    })
    return next(e)
  })

  on('command.run', { command: 'task-agents' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Subagents' })
    return { text: 'Subagents pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const startedAt = await $.clock.now()
    await update($, todos, list => list.filter(t => t.status !== 'completed'))
    await update($, run, () => ({ startedAt, now: startedAt, isActive: true, tools: 0 }))
    void $.ui.open({ id: PANE, title: 'Subagents' })
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => void refresh($))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    await update($, run, r => ({ ...r, tools: r.tools + 1 }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [
        ...composed.sections,
        {
          id: 'task-progress:tasks',
          scope: 'session' as const,
          text: TASK_HINT,
        },
      ],
    }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    await update($, todos, () =>
      e.todos.map((t, i) => ({ id: `todo-${i}`, content: t.content, status: t.status })),
    )
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const { id, subject } = ran.result.task
      await update($, todos, list => [
        ...list.filter(t => t.id !== id),
        { id, content: subject, status: 'pending' },
      ])
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await update($, todos, list => {
        if (e.status === 'deleted') {
          return list.filter(t => t.id !== e.taskId)
        }
        const known = list.some(t => t.id === e.taskId)
        const base = known
          ? list
          : [...list, { id: e.taskId, content: e.subject ?? `task ${e.taskId}`, status: 'pending' as const }]
        return base.map(t =>
          t.id === e.taskId
            ? { ...t, content: e.subject ?? t.content, status: e.status ?? t.status }
            : t,
        )
      })
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    // Subagent turns also complete here; only the main loop ends the run.
    if (e.agentId === undefined) {
      tick?.cancel()
      tick = undefined
      await refresh($)
      await update($, run, r => ({ ...r, isActive: false }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await read($, run)
    const list = await read($, todos)
    const rows = await read($, agents)
    const { done, total, label } = measure(list, rows)
    const isOpen = r.isActive || (total > 0 && done < total)

    if (e.props.hasSurvey || !isOpen) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const ratio = total === 0 ? 0 : done / total
    const elapsed = clock(r.now - r.startedAt)
    const isDone = total > 0 && done === total
    const fill = isDone ? PALETTE.done : PALETTE.fill
    const beat = Math.floor(r.now / TICK_MS)

    // Segmented cells. A background-coloured space is the same solid block in
    // every font, so the bar never depends on a glyph the font may not draw.
    // Task list: filled segments, and the next one pulses as the work front.
    // No list yet: a scanner bounces back and forth, leaving a faint trail.
    const lit = Math.floor(ratio * SEGMENTS)
    const period = 2 * (SEGMENTS - 1)
    const at = beat % period
    const head = at < SEGMENTS ? at : period - at
    const colorOf = (i: number) => {
      if (total === 0) {
        const away = Math.abs(i - head)
        return away === 0 ? fill : away === 1 ? PALETTE.trail : PALETTE.track
      }
      if (i < lit) return fill
      return i === lit && r.isActive && !isDone && beat % 2 === 0
        ? fill
        : PALETTE.track
    }

    const bar = []
    for (let i = 0; i < SEGMENTS; i++) {
      bar.push(<Text key={`s${i}`} backgroundColor={colorOf(i)}>{' '}</Text>)
      if (i < SEGMENTS - 1) bar.push(<Text key={`g${i}`}>{' '}</Text>)
    }
    const percent = total === 0 ? '--%' : `${Math.round(ratio * 100)}%`

    return (
      <Box>
        {bar}
        <Text bold color={fill}>
          {' '}
          {percent.padStart(4)}
        </Text>
        <Text color={PALETTE.text}>{total === 0 ? '' : `  ${done}/${total}`}</Text>
        <Text color={PALETTE.muted} wrap="truncate-end">
          {' '}
          · {elapsed}
          {total === 0 ? ` · ${r.tools} tool calls` : ''}
          {label === '' ? '' : ` · ${label}`}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, agents)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)

    if (rows.length === 0) {
      return <Text dimColor>No subagents yet.</Text>
    }

    const running = rows.filter(a => !FINISHED.includes(a.status)).length

    return (
      <Box flexDirection="column">
        <Text bold>
          {rows.length} subagents · {running} active
        </Text>
        {rows.slice(-room).map(a => (
          <Box key={a.id}>
            <Text color={COLOR[a.status]}>{ICON[a.status] ?? '·'} </Text>
            <Text dimColor={FINISHED.includes(a.status)} wrap="truncate-end">
              {a.label}
            </Text>
            <Text dimColor>
              {' '}
              {a.type} · {a.status}
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
