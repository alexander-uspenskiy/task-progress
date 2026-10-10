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
// The price fetch never holds anything up for longer than this.
const FETCH_TIMEOUT_MS = 8000
// Limits on the pricing page, which is read as hostile input.
const PAGE_MAX_CHARS = 400_000
const LINE_MAX_CHARS = 2000
const ROWS_MAX = 200
const PRICE_MAX = 1000 // USD per million tokens
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
//           plus `retired`, what agents dropped from the list (the cap) had spent
//   seen    what each turn's own requests have already added, so a turn's
//           closing report only adds what they missed
const ledger = atom({ plugin: 'task-progress', key: 'ledger1' } as const, {
  turn: NONE,
  agents: [],
  seen: [],
  retired: NONE,
})
// List prices, fetched from Anthropic's pricing page and refreshed daily. Absent
// until a fetch has worked: with no price for a model no cost is shown for it.
const prices = atom({ plugin: 'task-progress', key: 'prices1' } as const, null)
const diag = atom({ plugin: 'task-progress', key: 'diag2' } as const, {
  steps: 0,
  withUsage: 0,
  subSteps: 0,
  completes: 0,
  transcripts: 0,
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
// Every figure that is read from a file, the store or an event is untrusted: it is
// coerced to a finite, non-negative number no larger than a limit.
const TOK_MAX = 1e12
const COST_MAX = 1e9
const num = (v: unknown, max = TOK_MAX) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const cap = (n: number) => Math.min(TOK_MAX, n)
const capCost = (n: number) => Math.min(COST_MAX, n)
const sumUsage = (list: Usage[]): Tok => ({
  input: cap(list.reduce((n, x) => n + x.input, 0)),
  output: cap(list.reduce((n, x) => n + x.output, 0)),
  cached: cap(list.reduce((n, x) => n + x.cached, 0)),
  written: cap(list.reduce((n, x) => n + x.written, 0)),
  cost: capCost(list.reduce((n, x) => n + x.cost, 0)),
  unpriced: cap(list.reduce((n, x) => n + x.unpriced, 0)),
})
const addTok = (t: Tok, b: Tok): Tok => ({
  input: cap(t.input + b.input),
  output: cap(t.output + b.output),
  cached: cap(t.cached + b.cached),
  written: cap(t.written + b.written),
  cost: capCost(t.cost + b.cost),
  unpriced: cap(t.unpriced + b.unpriced),
})
// Other agents kept in the per-agent lists (the main agent is always kept).
const KEEP_AGENTS = 40
const KEEP_SEEN = 50
// What is accepted back from the store, whatever it says.
const MAX_AGENTS = 100
const MAX_SEEN = 100
const MAX_HISTORY = 40
const ID_MAX = 200
// Oldest first out: the lists put the newest entry last.
const prune = <T extends { agentId: string }>(list: T[]): T[] => {
  const others = list.filter(x => x.agentId !== MAIN)
  if (others.length <= KEEP_AGENTS) return list
  const gone = new Set(others.slice(0, others.length - KEEP_AGENTS))
  return list.filter(x => !gone.has(x))
}
const cleanCounts = (o: Record<string, unknown>): Counts => ({
  input: num(o.input),
  output: num(o.output),
  cached: num(o.cached),
  written: num(o.written),
})
const cleanTok = (v: unknown): Tok => {
  const o = isObj(v) ? v : {}
  return { ...cleanCounts(o), cost: num(o.cost, COST_MAX), unpriced: num(o.unpriced) }
}
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX
// One request's tokens, added to the turn and the agent (and to what the
// turn's own requests have counted, when they say which turn they are).
// A ledger written by an older build may lack fields a newer one reads: fill them in.
// One read back from the store may say anything: every field is coerced, entries of
// the wrong shape are dropped and the lists are capped.
const norm = (l: unknown): Ledger => {
  const o = isObj(l) ? l : {}
  const agents: Usage[] = []
  for (const a of Array.isArray(o.agents) ? o.agents : []) {
    if (isObj(a) && isKey(a.agentId)) agents.push({ agentId: a.agentId, ...cleanTok(a) })
  }
  // too many: the oldest of the other agents go first
  let excess = agents.length - MAX_AGENTS
  const kept = excess <= 0 ? agents : agents.filter(a => a.agentId === MAIN || excess-- <= 0)
  const seen: Seen[] = []
  for (const x of Array.isArray(o.seen) ? o.seen : []) {
    if (isObj(x) && isKey(x.turnId)) seen.push({ turnId: x.turnId, ...cleanCounts(x) })
  }
  return {
    turn: cleanTok(o.turn),
    agents: kept,
    seen: seen.slice(-MAX_SEEN),
    retired: cleanTok(o.retired),
  }
}
const tally = (old: Ledger, agentId: string, b: Tok, turnId?: string): Ledger => {
  const l = norm(old)
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
  const agents = prune([...l.agents.filter(x => x.agentId !== agentId), sum])
  // an agent dropped by the cap keeps counting in the session total
  const dropped = [...l.agents.filter(x => x.agentId !== agentId), sum].filter(x => !agents.includes(x))
  return {
    turn: addTok(l.turn, b),
    agents,
    seen,
    retired: dropped.length === 0 ? l.retired : addTok(l.retired, sumUsage(dropped)),
  }
}
const seconds = (ms: number) => (ms < 950 ? `${Math.max(1, Math.round(ms / 100) * 100)}ms` : `${(ms / 1000).toFixed(1)}s`)

// Secrets are cut out of a hint BEFORE it is shortened, because the hint is
// shown on screen and kept in state. Every pattern is linear-time: no nested
// quantifiers, and the open-ended ones are bounded.
const SENSITIVE = /token|secret|passw(?:or)?d|pwd|api[-_]?key|auth|credential/i
const SECRET_SHAPES =
  /\bsk-ant-[\w-]+|\bsk-[\w-]{8,}|\bgh[pos]_\w+|\bgithub_pat_\w+|\bxox[abprs]-[\w-]+|\bAKIA[0-9A-Z]{16}/g
const VALUE = `"[^"]{0,200}"|'[^']{0,200}'|[^\\s"'&;|]+`
const KEY_VALUE = new RegExp(`([\\w.-]{1,64})(["']?\\s*[=:]\\s*)(${VALUE})`, 'g')
const FLAG_VALUE = new RegExp(`(--?[\\w.-]{1,64})(\\s+)("[^"]{0,200}"|'[^']{0,200}'|[^\\s"'&;|-][^\\s"'&;|]*)`, 'g')
const redact = (text: string) =>
  text
    // https://user:pass@host/p?a=b#c -> https://…@host/p?…  (one pass over each URL)
    .replace(/[a-z][a-z0-9+.-]{0,20}:\/\/[^\s"']*/gi, url => {
      const start = url.indexOf('://') + 3
      let end = start
      while (end < url.length && url[end] !== '/' && url[end] !== '?' && url[end] !== '#') end++
      const at = url.lastIndexOf('@', end - 1)
      const host = at >= start ? `…@${url.slice(at + 1, end)}` : url.slice(start, end)
      const rest = url.slice(end)
      const cut = rest.search(/[?#]/)
      return `${url.slice(0, start)}${host}${cut < 0 ? rest : `${rest.slice(0, cut)}?…`}`
    })
    // Authorization: Bearer x, and a bare Bearer x
    .replace(/(authorization["']?\s*[=:]\s*)(?:(?:bearer|basic|token|digest)\s+)?[^\s"']+/gi, '$1…')
    .replace(/\bbearer\s+[^\s"']+/gi, 'Bearer …')
    // well-known token shapes, and long hex / base64 runs
    .replace(SECRET_SHAPES, '…')
    .replace(/[A-Za-z0-9+/]{32,}/g, run =>
      /\d/.test(run) && /[A-Za-z]/.test(run) && (!run.includes('/') || (/[a-z]/.test(run) && /[A-Z]/.test(run)))
        ? '…'
        : run,
    )
    // key=value, key: value and NAME=value cmd (also `export NAME=value`)
    .replace(KEY_VALUE, (m, key: string, sep: string) => (SENSITIVE.test(key) ? `${key}${sep}…` : m))
    // --flag value
    .replace(FLAG_VALUE, (m, flag: string, space: string) => (SENSITIVE.test(flag) ? `${flag}${space}…` : m))

// The most telling argument of a tool call, as one short string for the pane.
const hintOf = (input: object) => {
  const o = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'pattern', 'command', 'query', 'url', 'description']) {
    const v = o[key]
    if (typeof v === 'string' && v !== '') {
      const one = redact(v.replace(/\s+/g, ' ').trim())
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
  const good = xs.filter(x => typeof x === 'number' && Number.isFinite(x) && x >= 0)
  if (good.length === 0) return fallback
  const sorted = good.sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? fallback
}
// The turns kept in the store, read back: whatever it says, a list of sane turns.
const cleanHistory = (v: unknown): Turn[] => {
  const out: Turn[] = []
  for (const t of Array.isArray(v) ? v : []) {
    if (!isObj(t)) continue
    out.push({ tools: num(t.tools, 1e6), seconds: num(t.seconds, 1e7) })
  }
  return out.slice(-MAX_HISTORY)
}

// No task list: guess how far along the turn is from what earlier turns cost.
// Whichever of tool calls or time is further along sets the guess, never
// past 95%, so the bar can only finish when the turn really does.
const estimate = (r: Run) => {
  const seconds = (r.now - r.startedAt) / 1000
  const byTools = r.tools / (Math.max(1, r.expectedTools) * 1.3)
  const byTime = seconds / (Math.max(1, r.expectedSeconds) * 1.3)
  const shown = Math.max(byTools, byTime)
  return Number.isFinite(shown) ? Math.min(0.95, Math.max(0, shown)) : 0
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
  input: num(u.input_tokens),
  output: num(u.output_tokens),
  cached: num(u.cache_read_input_tokens),
  written: num(u.cache_creation_input_tokens),
})

// The pricing page's model table: one row per model, a second row for a
// model's long-prompt rates. Anything that does not parse is left out. The page
// is hostile input: only its first PAGE_MAX_CHARS are read, a line over
// LINE_MAX_CHARS is skipped, at most ROWS_MAX rows are kept, and every pattern
// below is linear (none can rescan the rest of the line from each character).
function parsePrices(md: string): PriceRow[] {
  const rows: PriceRow[] = []
  const price = (cell: string | undefined) => {
    const m = /\$([\d.]+)/.exec(cell ?? '')
    const n = m ? Number(m[1]) : NaN
    return Number.isFinite(n) && n >= 0 && n <= PRICE_MAX ? n : NaN
  }
  for (const line of md.slice(0, PAGE_MAX_CHARS).split('\n')) {
    if (rows.length >= ROWS_MAX) break
    if (line.length > LINE_MAX_CHARS || !line.startsWith('| Claude')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length < 6) continue
    // `[^\][]` and `[^()]` stop at the next bracket, so a run of "[" or "(" is
    // scanned once, not once per bracket.
    const label = (cells[0] ?? '').replace(/\[([^\][]*)\]\([^()]*\)/g, '$1')
    const name = label.replace(/\([^()]*\)/g, '').trim().toLowerCase().replace(/^claude\s+/, '')
    if (name === '' || name.length > 80) continue
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
    const limit = over ? Number((over[1] ?? '0').replace(/,/g, '')) : undefined
    if (limit !== undefined && !Number.isFinite(limit)) continue
    rows.push(limit === undefined ? row : { ...row, over: limit })
  }
  return rows
}

// What these tokens cost at the model's list price; undefined when the model
// has no price, so the caller can leave it out.
// All cache writes are priced at the 5-minute rate: the engine's ModelUsage reports one
// cache_creation_input_tokens count per request, with no 5m/1h split.
function costOf(list: Prices | null, model: string, c: Counts): number | undefined {
  if (!isObj(list) || !Array.isArray(list.rows) || typeof model !== 'string') return undefined
  // a trailing "[1m]" is cut by position (a pattern over a hostile string could be slow)
  const open = model.indexOf('[')
  const id = (open < 0 ? model : model.slice(0, open)).toLowerCase().replace(/-\d{8}$/, '')
  const rows = list.rows.filter(r => isObj(r) && r.id === id)
  const prompt = c.input + c.cached + c.written
  const row = rows.find(r => r.over !== undefined && prompt > r.over) ?? rows.find(r => r.over === undefined)
  if (row === undefined) return undefined
  const p = (n: unknown) => num(n, PRICE_MAX)
  return capCost((c.input * p(row.input) + c.written * p(row.write5m) + c.cached * p(row.cacheRead) + c.output * p(row.output)) / 1e6)
}
// A price row read back from the store: only a row that is whole and in range is kept.
const cleanPrices = (v: unknown): Prices | null => {
  if (!isObj(v) || !Array.isArray(v.rows)) return null
  const rows: PriceRow[] = []
  for (const r of v.rows.slice(0, ROWS_MAX)) {
    if (!isObj(r) || typeof r.id !== 'string' || r.id.length === 0 || r.id.length > 100) continue
    const f = [r.input, r.write5m, r.write1h, r.cacheRead, r.output]
    if (!f.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= PRICE_MAX)) continue
    const row: PriceRow = {
      id: r.id,
      input: r.input as number,
      write5m: r.write5m as number,
      write1h: r.write1h as number,
      cacheRead: r.cacheRead as number,
      output: r.output as number,
    }
    if (r.over !== undefined) {
      if (typeof r.over !== 'number' || !Number.isFinite(r.over) || r.over < 0 || r.over > TOK_MAX) continue
      row.over = r.over
    }
    rows.push(row)
  }
  const at = v.fetchedAt
  return { fetchedAt: typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0, rows }
}

// The pricing page, or undefined when it has not answered within
// FETCH_TIMEOUT_MS (the request is then left to finish or fail on its own).
async function fetchPage($: EngineInterface) {
  const stop = new AbortController()
  const fetching = $.http.fetch(PRICING_URL, {
    headers: { 'user-agent': USER_AGENT, accept: 'text/markdown' },
  })
  fetching.catch(() => {})
  const timeout = $.clock
    .sleep(FETCH_TIMEOUT_MS, { signal: stop.signal })
    .then(() => undefined, () => undefined)
  try {
    return await Promise.race([fetching, timeout])
  } finally {
    stop.abort()
  }
}

// Load the saved prices, and fetch fresh ones when they are over a day old (a
// failed fetch is not retried within the hour). Any failure leaves things as
// they were: prices simply stay unknown, and no cost is shown.
async function loadPrices($: EngineInterface) {
  try {
    const now = await $.clock.now()
    const saved = cleanPrices(await $.store.get('prices'))
    if (saved !== null) {
      await update($, prices, () => saved)
    }
    const triedAt = await $.store.get('pricesTriedAt')
    const tried = typeof triedAt === 'number' && Number.isFinite(triedAt) ? triedAt : 0
    const age = saved === null ? -1 : now - saved.fetchedAt
    // a date in the future is not fresh
    const isFresh = age >= 0 && age < DAY
    if (isFresh || (now - tried >= 0 && now - tried < HOUR)) return
    await $.store.set('pricesTriedAt', now)
    const res = await fetchPage($)
    if (res === undefined || !res.ok) return
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
  await update($, ledger, old => {
    const l = norm(old)
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
  await update($, ledger, () => ({ turn: NONE, agents: [], seen: [], retired: NONE }))
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
  await update($, diag, () => ({ steps: 0, withUsage: 0, subSteps: 0, completes: 0, transcripts: 0, error: '' }))
}

// The ledger is kept in the plugin store under the session's id, so a reload of
// the mod, a restart, or a state value the engine could not keep does not lose the
// session's totals. Written at most every 2 s (and at the end of a turn).
const SAVED = 'ledger:'
const KEEP_SAVED = 8
let savedJson = ''
let savedAt = 0
// The session id whose saved copy session.end has deleted: nothing is written under it
// again (a late save must not bring the key back) until a session.start. '*': whichever.
let endedId: string | undefined
// per subagent: how many times its transcript was tried, and when last (the newest 200)
const attempts = new Map<string, { n: number; at: number }>()
const MAX_ATTEMPTS = 200
const RETRY_MS = 5000
const MAX_TRIES = 5
const noteAttempt = (id: string, v: { n: number; at: number }) => {
  attempts.delete(id)
  attempts.set(id, v)
  while (attempts.size > MAX_ATTEMPTS) {
    for (const oldest of attempts.keys()) {
      attempts.delete(oldest)
      break
    }
  }
}
async function saveLedger($: EngineInterface, force = false) {
  try {
    const now = await $.clock.now()
    if (!force && now - savedAt < 2000) return
    const l = norm(await read($, ledger))
    const json = JSON.stringify(l)
    if (json === savedJson) return
    const key = `${SAVED}${await $.session.id()}`
    if (endedId === '*' || key === `${SAVED}${endedId}`) return
    savedJson = json
    savedAt = now
    await $.store.set(key, { at: now, ledger: l })
    const keys = ((await $.store.keys()) ?? []).filter(k => typeof k === 'string' && k.startsWith(SAVED))
    if (keys.length > KEEP_SAVED) {
      const rows: { k: string; at: number }[] = []
      for (const k of keys) {
        const v = await $.store.get(k)
        rows.push({ k, at: isObj(v) ? num(v.at, Number.MAX_SAFE_INTEGER) : 0 })
      }
      rows.sort((a, b) => a.at - b.at)
      for (const r of rows.slice(0, rows.length - KEEP_SAVED)) await $.store.delete(r.k)
    }
  } catch {
    // totals just stay in memory
  }
}
// Back from the store when the in-memory ledger is empty (a reload cleared it).
async function restoreLedger($: EngineInterface) {
  try {
    const l = norm(await read($, ledger))
    if (l.agents.length > 0 || l.retired.input + l.retired.output + l.retired.cached > 0) return
    const saved = await $.store.get(`${SAVED}${await $.session.id()}`)
    if (!isObj(saved) || !isObj(saved.ledger)) return
    await update($, ledger, () => norm(saved.ledger))
    savedJson = ''
  } catch {
    // start from nothing
  }
}

// Remember which model (and effort, when it is known) an agent runs on. Effort is
// only reported with a model request, so an agent whose requests never reach the
// hooks has a model (from its spawn or its transcript) and no effort.
async function noteSetup($: EngineInterface, agentId: string, model: string, effort = '') {
  if (model === '') return
  await update($, setups, list => {
    const had = list.find(x => x.agentId === agentId)
    if (had !== undefined && had.model === model && (effort === '' || had.effort === effort)) return list
    return prune([
      ...list.filter(x => x.agentId !== agentId),
      { agentId, model, effort: effort === '' ? had?.effort ?? '' : effort },
    ])
  })
}

// What a subagent's own transcript says it used (the API's usage, once per message).
// The model requests of a subagent may not reach this plugin's hooks, so when it
// stops, anything the live counting missed is added from here.
// The transcript is hostile input: a line that is not what it should be is skipped (never
// thrown at), every number is clamped, and the work is bounded.
const TRANSCRIPT_LIMIT = 4 * 1024 * 1024 // the most one `$.fs.read` returns
const MAX_LINES = 300_000
const MAX_LINE_CHARS = 2_000_000
const MODEL_MAX = 80
const cleanModel = (v: unknown) =>
  typeof v === 'string' ? v.slice(0, MODEL_MAX).replace(/[^A-Za-z0-9._[\]-]/g, '') : ''

// An error as one short line for the pane: the home directory is `~`, any word that
// looks like a path is `…`, and it is cut short.
function scrub(err: unknown, home: string): string {
  let text: string
  try {
    text = err instanceof Error ? err.message : String(err)
  } catch {
    text = 'error'
  }
  text = text.slice(0, 400)
  if (home.length > 1) text = text.split(home).join('~')
  return text
    .split(/\s+/)
    .map(w => (w.includes('/') || w.includes('\\') ? '…' : w))
    .join(' ')
    .slice(0, 100)
}
async function noteError($: EngineInterface, label: string, err: unknown) {
  try {
    let home = ''
    try {
      home = String((await $.env.get('HOME')) ?? '')
    } catch {
      // no home to hide
    }
    const text = `${label}${scrub(err, home)}`.slice(0, 120)
    await update($, diag, d => ({ ...d, error: text }))
  } catch {
    // an error note must not raise one
  }
}

// ok: read and counted; over: too big to read, never tried again; failed: not read.
async function creditTranscript($: EngineInterface, agentId: string, path: string): Promise<'ok' | 'over' | 'failed'> {
  const over = async () => {
    noteAttempt(agentId, { n: MAX_TRIES, at: 0 })
    await update($, diag, d => ({ ...d, error: 'transcript over 4 MiB, not counted' }))
    return 'over' as const
  }
  try {
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096) return 'failed'
    // `$.fs.read` takes no offset or length, so a file over its limit cannot be read in
    // part: ask its size first (an answer that cannot be had leaves it to the read).
    try {
      const st = await $.fs.stat(path)
      if (st.kind === 'file' && st.size > TRANSCRIPT_LIMIT) return await over()
    } catch {
      // the read below says what is wrong
    }
    let text: unknown
    try {
      text = await $.fs.read(path)
    } catch (err) {
      let said = ''
      try {
        said = err instanceof Error ? err.message : String(err)
      } catch {
        // unreadable message
      }
      if (/4\s*MiB|too (?:large|big)|exceeds?\b/i.test(said.slice(0, 400))) return await over()
      throw err
    }
    if (typeof text !== 'string') return 'failed'
    const list = await read($, prices)
    // A message is written several times as it streams, the first lines with partial
    // counts (an output of 16 that ends at 196): keep the largest of each field.
    const byMessage = new Map<string, { model: string; c: Counts }>()
    let pos = 0
    for (let n = 0; n < MAX_LINES && pos <= text.length; n++) {
      let end = text.indexOf('\n', pos)
      if (end < 0) end = text.length
      const line = text.slice(pos, end)
      pos = end + 1
      if (line.length === 0 || line.length > MAX_LINE_CHARS) continue
      let row: unknown
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!isObj(row) || row.type !== 'assistant') continue
      const m = row.message
      if (!isObj(m)) continue
      const u = m.usage
      const id = m.id
      if (!isObj(u) || typeof id !== 'string' || id.length > ID_MAX) continue
      const seen = byMessage.get(id)
      const c: Counts = {
        input: Math.max(seen?.c.input ?? 0, num(u.input_tokens)),
        output: Math.max(seen?.c.output ?? 0, num(u.output_tokens)),
        cached: Math.max(seen?.c.cached ?? 0, num(u.cache_read_input_tokens)),
        written: Math.max(seen?.c.written ?? 0, num(u.cache_creation_input_tokens)),
      }
      byMessage.set(id, { model: cleanModel(m.model) || (seen?.model ?? ''), c })
    }
    let total: Tok = NONE
    let lastModel = ''
    for (const { model, c } of byMessage.values()) {
      if (model !== '') lastModel = model
      const cost = costOf(list, model, c)
      total = addTok(total, { ...c, cost: cost ?? 0, unpriced: cost === undefined ? 1 : 0 })
    }
    // only what live counting has not already counted
    let added = false
    await update($, ledger, old => {
      const l = norm(old)
      added = false
      const have = l.agents.find(x => x.agentId === agentId)
      const gap = (a: number, b: number | undefined) => Math.max(0, a - (b ?? 0))
      const missing: Tok = {
        input: gap(total.input, have?.input),
        output: gap(total.output, have?.output),
        cached: gap(total.cached, have?.cached),
        written: gap(total.written, have?.written),
        cost: gap(total.cost, have?.cost),
        unpriced: have === undefined ? total.unpriced : 0,
      }
      if (missing.input + missing.output + missing.cached + missing.written === 0) return l
      added = true
      return tally(l, agentId, missing)
    })
    if (added) await update($, diag, d => ({ ...d, transcripts: d.transcripts + 1 }))
    await noteSetup($, agentId, lastModel)
    return 'ok'
  } catch (err) {
    await noteError($, 'transcript: ', err)
    return 'failed'
  }
}

// An agent id becomes part of a file name: only a plain one is accepted.
const SAFE_ID = /^[\w@.-]{1,128}$/
const isSafeId = (id: unknown): id is string => typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..')
const isSafeName = (n: unknown): n is string =>
  typeof n === 'string' && n !== '' && !n.includes('/') && !n.includes('\\') && !n.includes('..')

// Where a subagent's transcript is: <home>/.claude/projects/<project>/<session id>/
// subagents/agent-<id>.jsonl. The project folder is named after the directory the
// session started in, so each project folder is looked in for this session's id.
async function findTranscript($: EngineInterface, agentId: string): Promise<string | undefined> {
  if (!isSafeId(agentId)) return undefined
  const home = await $.env.get('HOME')
  if (home === undefined || home === '') return undefined
  const sid = await $.session.id()
  if (!isSafeName(sid)) return undefined
  const root = `${home}/.claude/projects`
  for (const dir of await $.fs.list(root)) {
    if (dir.kind !== 'dir' || !isSafeName(dir.name)) continue
    const path = `${root}/${dir.name}/${sid}/subagents/agent-${agentId}.jsonl`
    if (await $.fs.exists(path)) return path
  }
  return undefined
}

// A subagent that has finished with no tokens counted (its stop event never came,
// the live requests never reached the hooks, or the plugin was reloaded since) is
// read from its transcript. Each is tried a few times, spaced out, then left alone.
// `base`: the session transcript's path without `.jsonl`, when it is known.
async function backfillSeats($: EngineInterface, base?: string) {
  try {
    if (base !== undefined && (typeof base !== 'string' || base.length > 4096)) return
    const seats = await read($, roster)
    const l = norm(await read($, ledger))
    for (const s of Array.isArray(seats) ? seats : []) {
      if (!isObj(s) || !isSafeId(s.id) || s.endedAt === 0) continue
      if ((l.agents.find(x => x.agentId === s.id)?.output ?? 0) > 0) continue
      const now = await $.clock.now()
      const tried = attempts.get(s.id)
      // a transcript may not be written out yet: try again a few times, spaced out
      // (a path handed over by the end of a turn is tried whenever it comes; only the
      // search of the project folders is spaced out)
      if (tried !== undefined && (tried.n >= MAX_TRIES || (base === undefined && now - tried.at < RETRY_MS))) continue
      noteAttempt(s.id, { n: (tried?.n ?? 0) + 1, at: now })
      const path = base === undefined ? await findTranscript($, s.id) : `${base}/subagents/agent-${s.id}.jsonl`
      if (path !== undefined) await creditTranscript($, s.id, path)
    }
  } catch {
    // nothing to backfill
  }
}

// A subagent's stop does its file work from a timer (see the hook): off the path of
// the event it answers.
async function creditAndSave($: EngineInterface, agentId: string, path: string) {
  await creditTranscript($, agentId, path)
  await saveLedger($, true)
}

async function refresh($: EngineInterface) {
  await saveLedger($)
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

// One poll of the tick. True while something is still going: the run itself, or
// a subagent that has not finished.
async function poll($: EngineInterface) {
  await refresh($)
  await backfillSeats($)
  const r = await read($, run)
  const rows = await read($, agents)
  return r.isActive || rows.some(a => !FINISHED.includes(a.status))
}

export const register: Register = on => {
  let backfill: { cancel: () => void } | undefined
  let tick: { cancel: () => void } | undefined
  let pricing: { cancel: () => void } | undefined
  let isLoading = false
  // Work that a stop event scheduled (see classic.Stop): cancelled when the session ends.
  const jobs = new Set<{ cancel: () => void }>()

  on('session.start', async ($, e, next) => {
    // a new session may save its ledger again
    endedId = undefined
    await restoreLedger($)
    // A reload keeps the roster: read the transcripts of subagents that finished
    // while no tokens were being counted for them.
    backfill?.cancel()
    backfill = $.clock.after(0, () => {
      void backfillSeats($).catch(() => {})
    })
    // The fetch runs from a timer, as a dispatch of its own: it can never hold
    // this hook up.
    pricing?.cancel()
    pricing = $.clock.after(0, () => {
      if (isLoading) return
      isLoading = true
      void loadPrices($)
        .catch(() => {})
        .then(() => {
          isLoading = false
        })
    })
    await $.command.register({
      name: 'task-agents',
      description: 'Open the agents pane (status of every agent)',
    })
    return next(e)
  })

  // After a /clear the engine fires session.end (reason 'clear') and no
  // session.start, so this is what clears the old figures.
  // The session is over (a /clear too, which fires this and no session.start):
  // stop the timers first, so nothing writes while the state is being cleared,
  // then start from nothing.
  on('session.end', async ($, e, next) => {
    tick?.cancel()
    tick = undefined
    pricing?.cancel()
    pricing = undefined
    backfill?.cancel()
    backfill = undefined
    for (const job of jobs) job.cancel()
    jobs.clear()
    attempts.clear()
    // no save may write the key again once it is deleted (until a session.start)
    try {
      endedId = String(await $.session.id())
    } catch {
      endedId = '*'
    }
    try {
      await reset($)
    } catch {
      // a failed reset must not hold up the session's end
    }
    try {
      // the session is over: its saved totals go with it
      await $.store.delete(`${SAVED}${endedId}`)
      savedJson = ''
    } catch {
      // the saved copy stays; a new session has an id of its own
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'task-agents' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agents' })
    return { text: 'Agents pane opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await restoreLedger($)
    pricing?.cancel()
    pricing = $.clock.after(0, () => {
      if (isLoading) return
      isLoading = true
      void loadPrices($)
        .catch(() => {})
        .then(() => {
          isLoading = false
        })
    })
    // A message sent while a run is still going (the tick moved the clock within the
    // last few seconds) belongs to the same piece of work: the turn's totals, the
    // main agent's tools and the run's clock carry on. Only a prompt after the run
    // has ended, or a stale one that never reported its end, starts afresh.
    const startedAt = await $.clock.now()
    const before = await read($, run)
    const isSameWork = before.isActive && startedAt - before.now < 10_000
    if (!isSameWork) {
      const history = cleanHistory(await $.store.get('history'))
      const expectedTools = median(history.map(h => h.tools), 8)
      const expectedSeconds = median(history.map(h => h.seconds), 60)
      await update($, todos, list => list.filter(t => t.status !== 'completed'))
      await update($, calls, list => list.filter(c => c.agentId !== MAIN))
      await update($, ledger, l => ({ ...norm(l), turn: NONE }))
      await update($, run, () => ({
        startedAt,
        now: startedAt,
        isActive: true,
        tools: 0,
        expectedTools: Math.max(3, expectedTools),
        expectedSeconds: Math.max(15, expectedSeconds),
      }))
    }
    void $.ui.open({ id: PANE, title: 'Agents' })
    // Finished subagents with no tokens counted are read from their transcripts.
    backfill?.cancel()
    backfill = $.clock.after(0, () => {
      void backfillSeats($).catch(() => {})
    })
    if (!isSameWork || tick === undefined) {
      tick?.cancel()
      // It stops itself once nothing is going on, so a turn that never reports
      // its end cannot leave it polling; the next prompt starts it again.
      const mine = $.clock.every(TICK_MS, () => {
        void poll($)
          .then(isBusy => {
            if (isBusy) return
            mine.cancel()
            if (tick === mine) tick = undefined
          })
          .catch(() => {})
      })
      tick = mine
    }

    return next({ ...e, context: [...(e.context ?? []), TASK_HINT] })
  }).catch(($, e, next) => next(e))

  // A subagent has been started: its resolved model is known from here on.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    try {
      if (started.deny === undefined) await noteSetup($, started.agentId, started.model)
    } catch {
      // the model just stays unknown
    }
    return started
  }).catch(($, e, next) => next(e))

  // A subagent has stopped: read its own transcript for what it spent.
  // The file work runs from a timer, so the stop is answered at once.
  on('classic.SubagentStop', async ($, e, next) => {
    const id: unknown = e.agent_id
    const path: unknown = e.agent_transcript_path
    if (isSafeId(id) && typeof path === 'string') {
      const job = $.clock.after(0, () => {
        jobs.delete(job)
        void creditAndSave($, id, path).catch(() => {})
      })
      jobs.add(job)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The end of a main turn: the session transcript's path is known here. Its
  // subagents are read from a timer, so the end of the turn is not held up.
  on('classic.Stop', async ($, e, next) => {
    const file: unknown = e.transcript_path
    if (typeof file === 'string' && file.endsWith('.jsonl')) {
      const base = file.slice(0, -'.jsonl'.length)
      const job = $.clock.after(0, () => {
        jobs.delete(job)
        void backfillSeats($, base).catch(() => {})
      })
      jobs.add(job)
    }
    return next(e)
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
        subSteps: d.subSteps + (e.agentId === undefined ? 0 : 1),
      }))
    } catch (err) {
      await noteError($, '', err)
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
      await noteError($, '', err)
    }
    await saveLedger($, true)
    // Only the main loop's end ends the run; a subagent's turn also ends here.
    if (e.agentId === undefined) {
      tick?.cancel()
      tick = undefined
      await refresh($)
      const ended = await read($, run)
      const seconds = Math.round((ended.now - ended.startedAt) / 1000)
      if (ended.tools > 0 && ended.isActive) {
        const history = cleanHistory(await $.store.get('history'))
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
    const { turn: thisTurn, agents: perAgent, retired } = norm(await read($, ledger))
    const session = addTok(sumUsage(perAgent), retired)
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
    const { turn: thisTurn, agents: spent, retired } = norm(await read($, ledger))
    const configs = await read($, setups)
    const dg = await read($, diag)
    const known = await read($, prices)
    const session = addTok(sumUsage(spent), retired)
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
    const everyone = addTok(sumUsage(spent.filter(x => x.agentId !== MAIN)), retired)

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
                    {s.name !== '' ? s.name : s.type}
                    {setupKids2(s.id).length === 0 ? '' : ' · '}
                    {setupKids2(s.id)} · {tokens(spentBy === undefined ? 0 : fullInput(spentBy) + spentBy.output)} tok
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
          counted: {dg.withUsage}/{dg.steps} requests ({dg.subSteps} from subagents) · {dg.completes} turns ·{' '}
          {dg.transcripts} subagent transcripts ·{' '}
          {known === null ? 'no prices' : `${known.rows.length} prices`}
          {dg.error === '' ? '' : ` · error: ${dg.error}`}
        </Text>
      </Box>
    )
  })
}
