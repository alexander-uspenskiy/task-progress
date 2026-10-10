export type Todo = { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }
export type AgentRow = {
  id: string
  label: string
  name: string
  type: string
  status: string
}
// Every subagent seen this session, kept after the engine's own list drops it.
// endedAt is 0 while it is still going.
export type Seat = AgentRow & { firstSeen: number; endedAt: number }
export type Call = {
  id: string
  agentId: string
  tool: string
  hint: string
  status: 'running' | 'done' | 'error'
  startedAt: number
  ms: number
}
export type Setup = { agentId: string; model: string; effort: string }
// input: tokens the API read as fresh input; cached: cache reads; written: cache writes.
// The full input of a request is input + cached + written.
export type Counts = { input: number; output: number; cached: number; written: number }
// cost: estimated USD of the requests that had a price; unpriced: requests that had none.
export type Tok = Counts & { cost: number; unpriced: number }
// One model's list prices, USD per million tokens. `over`: applies to prompts over that many tokens.
export type PriceRow = {
  id: string
  input: number
  write5m: number
  write1h: number
  cacheRead: number
  output: number
  over?: number
}
export type Prices = { fetchedAt: number; rows: PriceRow[] }
export type Seen = { turnId: string } & Counts
export type Diag = { steps: number; withUsage: number; completes: number; error: string }
export type Usage = { agentId: string; input: number; output: number; cached: number }
export type Run = {
  startedAt: number
  now: number
  isActive: boolean
  tools: number
  expectedTools: number
  expectedSeconds: number
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': {
      todos: Todo[]
      agents: AgentRow[]
      run: Run
      calls: Call[]
      usage4: Usage[]
      setups: Setup[]
      roster1: Seat[]
      turn4: Tok
      prices1: Prices | null
      seen2: Seen[]
      diag: Diag
    }
  }
}
