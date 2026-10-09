import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, Call, Run, Setup, Tok, Todo, Totals, Usage } from '../types'

type Turn = { tools: number; seconds: number }

const PANE = 'task-agents'
const MAIN = 'main'
const SEGMENTS = 20
const TICK_MS = 400
const TASK_HINT =
  'Reminder: the user has a progress bar above the prompt that follows your task list. ' +
  'For work with three or more steps, create the steps first with TaskCreate ' +
  '(one short subject each), mark each in_progress when you start it and ' +
  'completed when it is done with TaskUpdate, so the bar shows real progress.'

const todos = atom({ plugin: 'task-progress', key: 'todos' } as const, [])
const calls = atom({ plugin: 'task-progress', key: 'calls' } as const, [])
const usage = atom({ plugin: 'task-progress', key: 'usage' } as const, [])
const NONE: Tok = { input: 0, output: 0, cached: 0 }
const totals = atom({ plugin: 'task-progress', key: 'totals' } as const, {
  session: NONE,
  run: NONE,
})
const setups = atom({ plugin: 'task-progress', key: 'setups' } as const, [])
const agents = atom({ plugin: 'task-progress', key: 'agents' } as const, [])
const run = atom({ plugin: 'task-progress', key: 'run' } as const, {
  startedAt: 0,
  now: 0,
  isActive: false,
  tools: 0,
  expectedTools: 8,
  expectedSeconds: 60,
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

const tokens = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`)
const seconds = (ms: number) => (ms < 950 ? `${Math.max(1, Math.round(ms / 100) * 100)}ms` : `${(ms / 1000).toFixed(1)}s`)

// The most telling argument of a tool call, as one short string for the pane.
const hintOf = (input: object) => {
  const o = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'pattern', 'command', 'query', 'url', 'description']) {
    const v = o[key]
    if (typeof v === 'string' && v !== '') {
      const one = v.replace(/\s+/g, ' ').trim()
      return one.length > 36 ? `${one.slice(0, 35)}…` : one
    }
  }
  return ''
}

// 12.1k in · 3.4k out · 32.7k cached
const tokText = (t: Tok) =>
  `${tokens(t.input)} in · ${tokens(t.output)} out · ${tokens(t.cached)} cached`

// claude-haiku-5-5-20260101 -> haiku-5-5
const shortModel = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const median = (xs: number[], fallback: number) => {
  if (xs.length === 0) return fallback
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? fallback
}

// No task list: guess how far along the turn is from what earlier turns cost.
// Whichever of tool calls or time is further along sets the guess, never
// past 95%, so the bar can only finish when the turn really does.
const estimate = (r: Run) => {
  const seconds = (r.now - r.startedAt) / 1000
  const byTools = r.tools / (r.expectedTools * 1.3)
  const byTime = seconds / (r.expectedSeconds * 1.3)
  return Math.min(0.95, Math.max(byTools, byTime))
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
    name: a.name ?? '',
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
    const history = ((await $.store.get('history')) ?? []) as Turn[]
    const expectedTools = median(history.map(h => h.tools), 8)
    const expectedSeconds = median(history.map(h => h.seconds), 60)
    await update($, todos, list => list.filter(t => t.status !== 'completed'))
    await update($, calls, list => list.filter(c => c.agentId !== MAIN))
    await update($, totals, t => ({ ...t, run: NONE }))
    await update($, run, () => ({
      startedAt,
      now: startedAt,
      isActive: true,
      tools: 0,
      expectedTools: Math.max(3, expectedTools),
      expectedSeconds: Math.max(15, expectedSeconds),
    }))
    void $.ui.open({ id: PANE, title: 'Subagents' })
    tick?.cancel()
    tick = $.clock.every(TICK_MS, () => void refresh($))

    return next({ ...e, context: [...(e.context ?? []), TASK_HINT] })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    await update($, run, r => ({ ...r, tools: r.tools + 1 }))
    // A call of the main loop or of a subagent: log it running, then done or
    // errored with its time.
    // The bookkeeping can never throw once the tool has run.
    const call: Call = {
      id: e.tool_use_id,
      agentId: e.agentId ?? MAIN,
      tool: String(e.tool),
      hint: hintOf(e),
      status: 'running',
      startedAt: await $.clock.now(),
      ms: 0,
    }
    await update($, calls, list => [...list, call].slice(-400))
    const ran = await next(e)
    try {
      const ms = (await $.clock.now()) - call.startedAt
      const status = ran.deny !== undefined || ran.isError === true ? 'error' : 'done'
      await update($, calls, list =>
        list.map(c => (c.id === call.id ? { ...c, status, ms } : c)),
      )
    } catch {
      // a failed log line must not fail the tool call
    }
    return ran
  }).catch(($, e, next) => next(e))

  // Each model request of a subagent says which model and effort it runs on.
  // turn.step streams, so the hook is a generator that forwards the stream.
  on('turn.step', async function* ($, e, next) {
    try {
      const agentId = e.agentId ?? MAIN
      const effort = e.effort === undefined ? '' : String(e.effort)
      const known = await read($, setups)
      const now = known.find(x => x.agentId === agentId)
      if (now === undefined || now.model !== e.model || now.effort !== effort) {
        await update($, setups, list => [
          ...list.filter(x => x.agentId !== agentId),
          { agentId, model: e.model, effort },
        ])
      }
    } catch {
      // a failed note must not fail the model request
    }
    const response = yield* next(e)
    try {
      const u = response.usage
      if (u !== null && u !== undefined) {
        const agentId = e.agentId ?? MAIN
        const add = (t: Tok): Tok => ({
          input: t.input + u.input_tokens,
          output: t.output + u.output_tokens,
          cached: t.cached + u.cache_read_input_tokens,
        })
        await update($, totals, t => ({ session: add(t.session), run: add(t.run) }))
        await update($, usage, list => {
          const prev = list.find(x => x.agentId === agentId)
          const sum: Usage = { agentId, ...add(prev ?? { ...NONE }) }
          return [...list.filter(x => x.agentId !== agentId), sum]
        })
      }
    } catch {
      // a failed count must not fail the model request
    }
    return response
  })

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
    // Only the main loop's end ends the run; a subagent's turn also ends here.
    if (e.agentId === undefined) {
      tick?.cancel()
      tick = undefined
      await refresh($)
      const ended = await read($, run)
      const seconds = Math.round((ended.now - ended.startedAt) / 1000)
      if (ended.tools > 0 && ended.isActive) {
        const history = ((await $.store.get('history')) ?? []) as Turn[]
        await $.store.set('history', [...history, { tools: ended.tools, seconds }].slice(-20))
      }
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

    // Segmented cells: a background-coloured space is the same solid block in
    // every font. Real progress from the task list when there is one, else the
    // estimate above, marked with a `~`.
    const isEstimate = total === 0
    const shown = isEstimate ? estimate(r) : ratio
    const lit = Math.floor(shown * SEGMENTS)
    const colorOf = (i: number) => {
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
    const percent = `${isEstimate ? '~' : ''}${Math.round(shown * 100)}%`
    const spent = await read($, totals)
    const hasTokens = spent.session.input + spent.session.output + spent.session.cached > 0

    return (
      <Box flexDirection="column">
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
          {isEstimate ? ` · ${r.tools} tool calls · estimated` : ''}
          {label === '' ? '' : ` · ${label}`}
        </Text>
      </Box>
      {hasTokens && (
        <Text color={PALETTE.muted} wrap="truncate-end">
          turn {tokText(spent.run)} · session {tokText(spent.session)}
        </Text>
      )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, agents)
    const log = await read($, calls)
    const spent = await read($, usage)
    const configs = await read($, setups)
    const spentAll = await read($, totals)
    const room = Math.max(6, (e.viewport?.rows ?? 24) - 4)
    const SHOWN_CALLS = 4

    const callLines = (mine: Call[], shown: number) => {
      const recent = mine.slice(-shown)
      return (
        <Box flexDirection="column">
          {mine.length > recent.length && (
            <Text dimColor>{'    '}… {mine.length - recent.length} earlier</Text>
          )}
          {recent.map(c => (
            <Box key={c.id}>
              <Text color={c.status === 'error' ? 'error' : c.status === 'done' ? 'success' : 'claude'}>
                {'    '}
                {c.status === 'error' ? '✗' : c.status === 'done' ? '✓' : '◐'}{' '}
              </Text>
              <Text>{c.tool}</Text>
              <Text dimColor wrap="truncate-end">
                {c.hint === '' ? '' : ` ${c.hint}`} ·{' '}
                {c.status === 'running' ? 'running' : seconds(c.ms)}
              </Text>
            </Box>
          ))}
        </Box>
      )
    }
    const setupText = (id: string) => {
      const setup = configs.find(x => x.agentId === id)
      return setup === undefined
        ? ''
        : ` · ${shortModel(setup.model)}${setup.effort === '' ? '' : ` · effort ${setup.effort}`}`
    }
    const costText = (id: string) => {
      const cost = spent.find(x => x.agentId === id)
      return cost === undefined
        ? ''
        : ` · ${tokens(cost.input + cost.output)} tok (${tokens(cost.input)} in / ${tokens(cost.output)} out${cost.cached > 0 ? ` / ${tokens(cost.cached)} cached` : ''})`
    }

    // Main agent: its own area at the top, with a tally of tools by name.
    const mainCalls = log.filter(c => c.agentId === MAIN)
    const tally = new Map<string, number>()
    for (const c of mainCalls) tally.set(c.tool, (tally.get(c.tool) ?? 0) + 1)
    const tallyText = [...tally.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([tool, n]) => `${tool}×${n}`)
      .join('  ')
    const failed = mainCalls.filter(c => c.status === 'error').length
    const mainShown = Math.min(SHOWN_CALLS + 1, Math.max(2, Math.floor(room / 3)))
    const mainUsed =
      2 + Math.min(mainCalls.length, mainShown) + (mainCalls.length > mainShown ? 1 : 0)
    const main = (
      <Box flexDirection="column">
        <Box>
          <Text color="claude">▌ </Text>
          <Text bold>Main agent</Text>
          <Text dimColor wrap="truncate-end">
            {setupText(MAIN)} · {mainCalls.length} tools
            {failed > 0 ? ` (${failed} failed)` : ''}
            {costText(MAIN)}
          </Text>
        </Box>
        {tallyText !== '' && (
          <Text dimColor wrap="truncate-end">{'    '}{tallyText}</Text>
        )}
        {callLines(mainCalls, mainShown)}
      </Box>
    )

    const running = rows.filter(a => !FINISHED.includes(a.status)).length

    // Subagents: newest first; each takes a header and its last few tool
    // calls, until the pane is full.
    const blocks = []
    let used = mainUsed + 2
    for (const a of [...rows].reverse()) {
      const mine = log.filter(c => c.agentId === a.id)
      const recent = mine.slice(-SHOWN_CALLS)
      const need = 1 + recent.length + (mine.length > recent.length ? 1 : 0)
      if (used + need > room && blocks.length > 0) break
      used += need
      const isOver = FINISHED.includes(a.status)
      blocks.push(
        <Box key={a.id} flexDirection="column">
          <Box>
            <Text color={COLOR[a.status]}>{ICON[a.status] ?? '·'} </Text>
            <Text bold dimColor={isOver} wrap="truncate-end">
              {a.name !== '' ? a.name : a.type}
              {a.label !== '' && a.label !== a.type ? ` (${a.label})` : ` (${a.type})`}
            </Text>
            <Text dimColor>
              {' '}
              {a.id.slice(0, 8)}
              {setupText(a.id)} · {a.status} · {mine.length} tools
              {costText(a.id)}
            </Text>
          </Box>
          {callLines(mine, SHOWN_CALLS)}
        </Box>,
      )
    }

    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          Session (all agents) · {tokText(spentAll.session)}
        </Text>
        <Text dimColor wrap="truncate-end">
          This turn · {tokText(spentAll.run)}
        </Text>
        <Text> </Text>
        {main}
        <Text> </Text>
        <Text bold>
          {rows.length === 0
            ? 'Subagents · none yet'
            : `Subagents · ${rows.length} total · ${running} active`}
        </Text>
        {blocks}
      </Box>
    )
  })
}
