import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentRow,
  Call,
  Counts,
  Ledger,
  PriceRow,
  Prices,
  Run,
  Seat,
  Seen,
  Tok,
  Todo,
  Turn,
  Usage,
} from '../types'

const PANE = 'task-agents'
const MAIN = 'main'
const SEGMENTS = 20
const TICK_MS = 400
const HOUR = 3_600_000
const DAY = 24 * HOUR
// Anthropic's own pricing page, published as markdown.
// The page answers 403 to some generic client names, so say who is asking.
const USER_AGENT = 'task-progress-mod (Claude Code plugin)'
const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
const TASK_HINT =
  'Reminder: the user has a progress bar above the prompt that follows your task list. ' +
  'For work with three or more steps, create the steps first with TaskCreate ' +
  '(one short subject each), mark each in_progress when you start it and ' +
  'completed when it is done with TaskUpdate, so the bar shows real progress.'

const todos = atom({ plugin: 'task-progress', key: 'todos' } as const, [])
const calls = atom({ plugin: 'task-progress', key: 'calls' } as const, [])
const NONE: Tok = { input: 0, output: 0, cached: 0, written: 0, cost: 0, unpriced: 0 }
// All token figures in ONE atom, written by one update per model request, so
// the parts can never disagree (the key is versioned so figures kept by
// earlier builds are not carried over):
//   turn    everything since the last prompt, all agents
//   agents  per agent, for the whole session; the session total is their sum
//   seen    what each turn's own requests have already added, so a turn's
//           closing report only adds what they missed
const ledger = atom({ plugin: 'task-progress', key: 'ledger1' } as const, {
  turn: NONE,
  agents: [],
  seen: [],
})
// List prices, fetched from Anthropic's pricing page and refreshed daily. Absent
// until a fetch has worked: with no price for a model no cost is shown for it.
const prices = atom({ plugin: 'task-progress', key: 'prices1' } as const, null)
const diag = atom({ plugin: 'task-progress', key: 'diag' } as const, {
  steps: 0,
  withUsage: 0,
  completes: 0,
  error: '',
})
const setups = atom({ plugin: 'task-progress', key: 'setups' } as const, [])
// Every subagent seen this session, so a finished one stays in the history after
// the engine's agent list has dropped it.
const roster = atom({ plugin: 'task-progress', key: 'roster1' } as const, [])
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

// A small icon for the kind of agent. The first rule that matches the agent's
// lowercased "<type> <name>" wins; edit or extend the list to taste. Single
// code point emoji only: they keep their width in every terminal font.
const ICON_RULES: [RegExp, string][] = [
  [/coordinat/, '🧭'], // coordinator
  [/orchestrat/, '🎼'], // orchestrator
  [/explor|search|find/, '🔍'], // searches the code
  [/plan|architect/, '🔬'], // architect
  [/design/, '📐'],
  [/review/, '🧐'],
  [/test|qa/, '🧪'],
  [/secur|audit/, '🔒'],
  [/research|guide|doc/, '📖'],
  [/status|config|setup/, '🔩'],
  [/code|coder|engineer|develop|implement|build/, '💻'], // engineer
  [/general|worker/, '👷'], // general-purpose worker
  [/teammate/, '🤝'],
]
const MAIN_ICON = '🧠'
const OTHER_ICON = '🤖'
const kindIcon = (type: string, name: string) => {
  const text = `${type} ${name}`.toLowerCase()
  return ICON_RULES.find(([rule]) => rule.test(text))?.[1] ?? OTHER_ICON
}

const tokens = (n: number) =>
  n < 1000
    ? String(n)
    : n < 1_000_000
      ? `${(n / 1000).toFixed(1)}k`
      : `${(n / 1_000_000).toFixed(1)}M`
const sumUsage = (list: Usage[]): Tok => ({
  input: list.reduce((n, x) => n + x.input, 0),
  output: list.reduce((n, x) => n + x.output, 0),
  cached: list.reduce((n, x) => n + x.cached, 0),
  written: list.reduce((n, x) => n + x.written, 0),
  cost: list.reduce((n, x) => n + x.cost, 0),
  unpriced: list.reduce((n, x) => n + x.unpriced, 0),
})
const addTok = (t: Tok, b: Tok): Tok => ({
  input: t.input + b.input,
  output: t.output + b.output,
  cached: t.cached + b.cached,
  written: t.written + b.written,
  cost: t.cost + b.cost,
  unpriced: t.unpriced + b.unpriced,
})
// Other agents kept in the per-agent lists (the main agent is always kept).
const KEEP_AGENTS = 40
const KEEP_SEEN = 50
// Oldest first out: the lists put the newest entry last.
const prune = <T extends { agentId: string }>(list: T[]): T[] => {
  const others = list.filter(x => x.agentId !== MAIN)
  if (others.length <= KEEP_AGENTS) return list
  const gone = new Set(others.slice(0, others.length - KEEP_AGENTS))
  return list.filter(x => !gone.has(x))
}
// One request's tokens, added to the turn and the agent (and to what the
// turn's own requests have counted, when they say which turn they are).
const tally = (l: Ledger, agentId: string, b: Tok, turnId?: string): Ledger => {
  const prev = l.agents.find(x => x.agentId === agentId)
  const sum: Usage = { agentId, ...addTok(prev ?? NONE, b) }
  const had = turnId === undefined ? undefined : l.seen.find(x => x.turnId === turnId)
  const seen: Seen[] =
    turnId === undefined
      ? l.seen
      : [
          ...l.seen.filter(x => x.turnId !== turnId),
          {
            turnId,
            input: (had?.input ?? 0) + b.input,
            output: (had?.output ?? 0) + b.output,
            cached: (had?.cached ?? 0) + b.cached,
            written: (had?.written ?? 0) + b.written,
          },
        ].slice(-KEEP_SEEN)
  return {
    turn: addTok(l.turn, b),
    agents: prune([...l.agents.filter(x => x.agentId !== agentId), sum]),
    seen,
  }
}
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

// The API's `input_tokens` is only the fresh part: the prompt's cached prefix
// is counted apart, so a 300k-token conversation reads "2 in". Show the whole
// input, and how much of it came from the cache.
//   299.7k in (299.6k cached) · 1.1k out
const fullInput = (t: Tok) => t.input + t.cached + t.written
// 12 cents -> $0.12; the `+` says some requests had no price and are left out.
const money = (n: number) =>
  n < 0.01 ? '<$0.01' : n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`
const tokBase = (t: Tok) =>
  `${tokens(fullInput(t))} in${t.cached > 0 ? ` (${tokens(t.cached)} cached)` : ''} · ${tokens(t.output)} out`
const estText = (t: Tok) => `est. ${money(t.cost)}${t.unpriced > 0 ? '+' : ''}`

// Parts of a line that should stand out. The estimated cost is bold, and the
// model and effort get a colour of their own (a theme key, so it follows the
// theme). `dimColor={false}` keeps them from fading with a dim line around them.
// `Text` is the element the render hook resolved for its surface.
const SETUP_COLOR = 'suggestion'
// 299.7k in (299.6k cached) · 1.1k out · est. $0.42
const tokKids = (Text: any, t: Tok): unknown[] => [
  tokBase(t),
  ...(t.cost > 0
    ? [' · ', <Text key="est" bold dimColor={false}>{estText(t)}</Text>]
    : []),
]
// sonnet-5-5 · effort high
const setupKids = (Text: any, model: string, effort: string): unknown[] => [
  <Text key="model" color={SETUP_COLOR} dimColor={false}>{shortModel(model)}</Text>,
  ...(effort === ''
    ? []
    : [' · ', <Text key="effort" color={SETUP_COLOR} dimColor={false}>{`effort ${effort}`}</Text>]),
]

// claude-haiku-5-5-20260101 -> haiku-5-5
const shortModel = (id: string) => id.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const HISTORY_SHOWN = 6
// In the history a finished agent is no longer news: its marker goes gray (a
// failed one stays red).
const HISTORY_DONE_COLOR = 'inactive'
// 5s, 1m05s
const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

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

const bumpOf = (u: {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}): Counts => ({
  input: u.input_tokens,
  output: u.output_tokens,
  cached: u.cache_read_input_tokens,
  written: u.cache_creation_input_tokens,
})

// The pricing page's model table: one row per model, a second row for a
// model's long-prompt rates. Anything that does not parse is left out.
function parsePrices(md: string): PriceRow[] {
  const rows: PriceRow[] = []
  const price = (cell: string | undefined) => {
    const m = /\$([\d.]+)/.exec(cell ?? '')
    return m ? Number(m[1]) : NaN
  }
  for (const line of md.split('\n')) {
    if (!line.startsWith('| Claude')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length < 6) continue
    const label = (cells[0] ?? '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    const name = label.replace(/\([^)]*\)/g, '').trim().toLowerCase().replace(/^claude\s+/, '')
    const over = /over ([\d,]+) tokens/.exec(label)
    const row: PriceRow = {
      id: `claude-${name.replace(/[\s.]+/g, '-')}`,
      input: price(cells[1]),
      write5m: price(cells[2]),
      write1h: price(cells[3]),
      cacheRead: price(cells[4]),
      output: price(cells[5]),
    }
    if ([row.input, row.write5m, row.write1h, row.cacheRead, row.output].some(n => !(n >= 0))) continue
    rows.push(over ? { ...row, over: Number((over[1] ?? '0').replace(/,/g, '')) } : row)
  }
  return rows
}

// What these tokens cost at the model's list price; undefined when the model
// has no price, so the caller can leave it out.
// All cache writes are priced at the 5-minute rate: the engine's ModelUsage reports one
// cache_creation_input_tokens count per request, with no 5m/1h split.
function costOf(list: Prices | null, model: string, c: Counts): number | undefined {
  if (list === null) return undefined
  const id = model.toLowerCase().replace(/\[.*\]$/, '').replace(/-\d{8}$/, '')
  const rows = list.rows.filter(r => r.id === id)
  const prompt = c.input + c.cached + c.written
  const row = rows.find(r => r.over !== undefined && prompt > r.over) ?? rows.find(r => r.over === undefined)
  if (row === undefined) return undefined
  return (c.input * row.input + c.written * row.write5m + c.cached * row.cacheRead + c.output * row.output) / 1e6
}

// Load the saved prices, and fetch fresh ones when they are over a day old (a
// failed fetch is not retried within the hour). Any failure leaves things as
// they were: prices simply stay unknown, and no cost is shown.
async function loadPrices($: EngineInterface) {
  try {
    const now = await $.clock.now()
    const saved = (await $.store.get('prices')) as Prices | undefined
    if (saved !== undefined && Array.isArray(saved.rows)) {
      await update($, prices, () => saved)
    }
    const tried = Number((await $.store.get('pricesTriedAt')) ?? 0)
    const isFresh = saved !== undefined && now - saved.fetchedAt < DAY
    if (isFresh || now - tried < HOUR) return
    await $.store.set('pricesTriedAt', now)
    const res = await $.http.fetch(PRICING_URL, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/markdown' },
    })
    if (!res.ok) return
    const rows = parsePrices(res.text)
    if (rows.length < 5) return
    const next: Prices = { fetchedAt: now, rows }
    await $.store.set('prices', next)
    await update($, prices, () => next)
  } catch {
    // keep whatever prices there were
  }
}

// The one write of a model request's tokens (see `ledger`). With a turnId the
// turn's own bookkeeping is updated in the same write.
async function count($: EngineInterface, agentId: string, c: Counts, model: string, turnId?: string) {
  const cost = costOf(await read($, prices), model, c)
  const bump: Tok = { ...c, cost: cost ?? 0, unpriced: cost === undefined ? 1 : 0 }
  await update($, ledger, l => tally(l, agentId, bump, turnId))
}

// A turn's closing report is the authority on what it cost: add what its own
// requests did not count, and forget the turn's bookkeeping, in one write. With
// no report (an aborted turn) there is nothing to add, but the entry still goes.
async function reconcile($: EngineInterface, turnId: string, agentId: string, u: (Parameters<typeof bumpOf>[0] & { model: string }) | undefined) {
  const list = u === undefined ? null : await read($, prices)
  await update($, ledger, l => {
    const rest: Ledger = { ...l, seen: l.seen.filter(x => x.turnId !== turnId) }
    if (u === undefined) return rest
    const had = l.seen.find(x => x.turnId === turnId)
    const full = bumpOf(u)
    const missing: Counts = {
      input: Math.max(0, full.input - (had?.input ?? 0)),
      output: Math.max(0, full.output - (had?.output ?? 0)),
      cached: Math.max(0, full.cached - (had?.cached ?? 0)),
      written: Math.max(0, full.written - (had?.written ?? 0)),
    }
    if (missing.input + missing.output + missing.cached + missing.written === 0) return rest
    const cost = costOf(list, u.model, missing)
    return tally(rest, agentId, { ...missing, cost: cost ?? 0, unpriced: cost === undefined ? 1 : 0 })
  })
}

// Back to the start of a session (not the prices: they are the same in the next one).
async function reset($: EngineInterface) {
  await update($, todos, () => [])
  await update($, calls, () => [])
  await update($, ledger, () => ({ turn: NONE, agents: [], seen: [] }))
  await update($, roster, () => [])
  await update($, setups, () => [])
  await update($, agents, () => [])
  await update($, run, () => ({
    startedAt: 0,
    now: 0,
    isActive: false,
    tools: 0,
    expectedTools: 8,
    expectedSeconds: 60,
  }))
  await update($, diag, () => ({ steps: 0, withUsage: 0, completes: 0, error: '' }))
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
  await update($, roster, old => {
    const listed = new Set(rows.map(r => r.id))
    // gone from the engine's list: it has ended
    const kept: Seat[] = old.map(s =>
      listed.has(s.id) || s.endedAt > 0
        ? s
        : { ...s, status: FINISHED.includes(s.status) ? s.status : 'completed', endedAt: now },
    )
    for (const r of rows) {
      const had = kept.findIndex(s => s.id === r.id)
      const isOver = FINISHED.includes(r.status)
      if (had < 0) {
        kept.push({ ...r, firstSeen: now, endedAt: isOver ? now : 0 })
      } else {
        const was = kept[had] as Seat
        kept[had] = { ...was, ...r, endedAt: isOver ? was.endedAt || now : 0 }
      }
    }
    return kept.slice(-40)
  })
}

export const register: Register = on => {
  let tick: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await loadPrices($)
    await $.command.register({
      name: 'task-agents',
      description: 'Open the agents pane (status of every agent)',
    })
    return next(e)
  })

  // After a /clear the engine fires session.end (reason 'clear') and no
  // session.start, so this is what clears the old figures.
  on('session.end', async ($, e, next) => {
    try {
      await reset($)
    } catch {
      // a failed reset must not hold up the session's end
    }
    return next(e)
  })

  on('command.run', { command: 'task-agents' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agents' })
    return { text: 'Agents pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await loadPrices($)
    const startedAt = await $.clock.now()
    const history = ((await $.store.get('history')) ?? []) as Turn[]
    const expectedTools = median(history.map(h => h.tools), 8)
    const expectedSeconds = median(history.map(h => h.seconds), 60)
    await update($, todos, list => list.filter(t => t.status !== 'completed'))
    await update($, calls, list => list.filter(c => c.agentId !== MAIN))
    await update($, ledger, l => ({ ...l, turn: NONE }))
    await update($, run, () => ({
      startedAt,
      now: startedAt,
      isActive: true,
      tools: 0,
      expectedTools: Math.max(3, expectedTools),
      expectedSeconds: Math.max(15, expectedSeconds),
    }))
    void $.ui.open({ id: PANE, title: 'Agents' })
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
        await update($, setups, list =>
          prune([...list.filter(x => x.agentId !== agentId), { agentId, model: e.model, effort }]),
        )
      }
    } catch {
      // a failed note must not fail the model request
    }
    const response = yield* next(e)
    try {
      const u = response.usage
      if (u !== null && u !== undefined) {
        await count($, e.agentId ?? MAIN, bumpOf(u), u.model, e.turnId)
      }
      await update($, diag, d => ({
        ...d,
        steps: d.steps + 1,
        withUsage: d.withUsage + (u === null || u === undefined ? 0 : 1),
      }))
    } catch (err) {
      await update($, diag, d => ({ ...d, error: String(err).slice(0, 120) }))
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
    // The turn's closing report is the authority on what it cost: add whatever
    // its own requests did not already count.
    try {
      await reconcile($, e.turnId, e.agentId ?? MAIN, e.usage)
      await update($, diag, d => ({ ...d, completes: d.completes + 1 }))
    } catch (err) {
      await update($, diag, d => ({ ...d, error: String(err).slice(0, 120) }))
    }
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
    const { turn: thisTurn, agents: perAgent } = await read($, ledger)
    const session = sumUsage(perAgent)
    const hasTokens = fullInput(session) + session.output > 0

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
          turn {tokKids(Text, thisTurn)} · session {tokKids(Text, session)}
        </Text>
      )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const seats = await read($, roster)
    const log = await read($, calls)
    const { turn: thisTurn, agents: spent } = await read($, ledger)
    const configs = await read($, setups)
    const dg = await read($, diag)
    const known = await read($, prices)
    const session = sumUsage(spent)
    const room = Math.max(8, (e.viewport?.rows ?? 24) - 4)
    const SHOWN_CALLS = 4

    // Every line is one Text that truncates at the pane's edge, and a label
    // that must stay whole sits in a Box that does not shrink, so a narrow
    // pane cuts the detail and never wraps a name onto two lines.
    const line = (key: string, label: string, detail: string, color?: string) => (
      <Box key={key}>
        <Box flexShrink={0}>
          <Text bold color={color}>{label}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">{detail}</Text>
      </Box>
    )
    const callLines = (mine: Call[], shown: number) => {
      const recent = mine.slice(-shown)
      return (
        <Box flexDirection="column">
          {mine.length > recent.length && (
            <Text dimColor>{'    '}… {mine.length - recent.length} earlier</Text>
          )}
          {recent.map(c => (
            <Box key={c.id}>
              <Box flexShrink={0}>
                <Text color={c.status === 'error' ? 'error' : c.status === 'done' ? 'success' : 'claude'}>
                  {'    '}
                  {c.status === 'error' ? '✗' : c.status === 'done' ? '✓' : '◐'} {c.tool}
                </Text>
              </Box>
              <Text dimColor wrap="truncate-end">
                {c.hint === '' ? '' : ` ${c.hint}`} ·{' '}
                {c.status === 'running' ? 'running' : seconds(c.ms)}
              </Text>
            </Box>
          ))}
        </Box>
      )
    }
    const setupKids2 = (id: string): unknown[] => {
      const setup = configs.find(x => x.agentId === id)
      return setup === undefined ? [] : setupKids(Text, setup.model, setup.effort)
    }
    const costKids = (id: string): unknown[] => {
      const cost = spent.find(x => x.agentId === id)
      return cost === undefined
        ? ['no tokens yet']
        : [`${tokens(fullInput(cost) + cost.output)} tok · `, ...tokKids(Text, cost)]
    }

    // Main agent: a card of its own at the top.
    const mainCalls = log.filter(c => c.agentId === MAIN)
    const tally = new Map<string, number>()
    for (const c of mainCalls) tally.set(c.tool, (tally.get(c.tool) ?? 0) + 1)
    const tallyText = [...tally.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([tool, n]) => `${tool}×${n}`)
      .join(' ')
    const failed = mainCalls.filter(c => c.status === 'error').length
    const mainShown = Math.min(SHOWN_CALLS + 1, Math.max(2, Math.floor(room / 3)))
    const mainUsed =
      4 + Math.min(mainCalls.length, mainShown) + (mainCalls.length > mainShown ? 1 : 0)
    const main = (
      <Box flexDirection="column">
        <Box>
          <Box flexShrink={0}>
            <Text bold color="claude">{`▌ ${MAIN_ICON} Main agent`}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{'  '}{setupKids2(MAIN)}</Text>
        </Box>
        <Text dimColor wrap="truncate-end">{'    '}{costKids(MAIN)}</Text>
        <Text dimColor wrap="truncate-end">
          {'    '}
          {mainCalls.length} tools{failed > 0 ? ` (${failed} failed)` : ''}
          {tallyText === '' ? '' : ` · ${tallyText}`}
        </Text>
        {callLines(mainCalls, mainShown)}
      </Box>
    )

    // Still going: a card each. Ended: one line each in the history below.
    const rows = seats.filter(s => s.endedAt === 0)
    const running = rows.length
    const ended = seats.filter(s => s.endedAt > 0).sort((a, b) => b.endedAt - a.endedAt)
    const shownEnded = Math.min(HISTORY_SHOWN, ended.length, Math.max(2, Math.floor(room / 4)))
    const everyone = sumUsage(spent.filter(x => x.agentId !== MAIN))

    // Subagents: newest first; each takes a card of a few lines, until the
    // pane is full (the history keeps its lines first).
    const blocks = []
    let used = mainUsed + 5 + (ended.length > 0 ? 2 + shownEnded : 0)
    for (const a of [...rows].reverse()) {
      const mine = log.filter(c => c.agentId === a.id)
      const recent = mine.slice(-SHOWN_CALLS)
      const need = 3 + recent.length + (mine.length > recent.length ? 1 : 0)
      if (used + need > room && blocks.length > 0) break
      used += need
      const isOver = FINISHED.includes(a.status)
      const name = a.name !== '' ? a.name : a.type
      const what = a.label !== '' && a.label !== a.type ? ` (${a.label})` : ''
      blocks.push(
        <Box key={a.id} flexDirection="column">
          <Box>
            <Box flexShrink={0}>
              <Text color={COLOR[a.status]}>{ICON[a.status] ?? '·'} {kindIcon(a.type, a.name)} </Text>
            </Box>
            <Text bold dimColor={isOver} wrap="truncate-end">{name}{what}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'    '}
            {a.id.slice(0, 8)} · {a.status}
            {setupKids2(a.id).length === 0 ? '' : ' · '}
            {setupKids2(a.id)}
          </Text>
          <Text dimColor wrap="truncate-end">
            {'    '}
            {mine.length} tools · {costKids(a.id)}
          </Text>
          {callLines(mine, SHOWN_CALLS)}
        </Box>,
      )
    }

    return (
      <Box flexDirection="column">
        <Text bold>Tokens</Text>
        <Text dimColor wrap="truncate-end">{'  '}session (all agents)</Text>
        <Text wrap="truncate-end">{'    '}{tokKids(Text, session)}</Text>
        <Text dimColor wrap="truncate-end">{'  '}this turn</Text>
        <Text wrap="truncate-end">{'    '}{tokKids(Text, thisTurn)}</Text>
        <Text> </Text>
        {main}
        <Text> </Text>
        <Text bold>
          {seats.length === 0
            ? 'Subagents · none yet'
            : `Subagents · ${seats.length} total · ${running} active`}
        </Text>
        {blocks}
        {blocks.length < rows.length && (
          <Text dimColor>
            {'  '}… {rows.length - blocks.length} older {rows.length - blocks.length === 1 ? 'agent' : 'agents'} not shown
          </Text>
        )}
        {ended.length > 0 && (
          <Box flexDirection="column">
            <Text> </Text>
            <Text bold wrap="truncate-end">
              History · {shownEnded} of {ended.length} finished · {tokens(fullInput(everyone) + everyone.output)} tok
              {everyone.cost > 0 ? ' · ' : ''}
              {everyone.cost > 0 ? <Text bold>{estText(everyone)}</Text> : ''}
            </Text>
            {ended.slice(0, shownEnded).map(s => {
              const spentBy = spent.find(x => x.agentId === s.id)
              const what = s.label !== '' && s.label !== s.type ? ` · ${s.label}` : ''
              return (
                <Box key={s.id}>
                  <Box flexShrink={0}>
                    <Text color={s.status === 'completed' ? HISTORY_DONE_COLOR : COLOR[s.status]}>
                      {ICON[s.status] ?? '·'} {kindIcon(s.type, s.name)}{' '}
                    </Text>
                  </Box>
                  <Text dimColor wrap="truncate-end">
                    {s.name !== '' ? s.name : s.type} · {tokens(spentBy === undefined ? 0 : fullInput(spentBy) + spentBy.output)} tok
                    {spentBy !== undefined && spentBy.cost > 0 ? ' · ' : ''}
                    {spentBy !== undefined && spentBy.cost > 0 ? (
                      <Text bold dimColor={false}>{estText(spentBy)}</Text>
                    ) : (
                      ''
                    )}{' '}
                    ·{' '}
                    {log.filter(c => c.agentId === s.id).length} tools · {span(s.endedAt - s.firstSeen)}
                    {what}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
        <Text> </Text>
        <Text dimColor wrap="truncate-end">
          counted: {dg.withUsage}/{dg.steps} requests · {dg.completes} turns ·{' '}
          {known === null ? 'no prices' : `${known.rows.length} prices`}
          {dg.error === '' ? '' : ` · error: ${dg.error}`}
        </Text>
      </Box>
    )
  })
}
