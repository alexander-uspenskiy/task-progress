export type Todo = { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }
export type AgentRow = {
  id: string
  label: string
  name: string
  type: string
  status: string
}
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
export type Tok = { input: number; output: number; cached: number }
export type Seen = { turnId: string } & Tok
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
      usage2: Usage[]
      setups: Setup[]
      turn2: Tok
      seen: Seen[]
      diag: Diag
    }
  }
}
