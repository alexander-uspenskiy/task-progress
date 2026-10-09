export type Todo = { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }
export type AgentRow = { id: string; label: string; type: string; status: string }
export type Run = { startedAt: number; now: number; isActive: boolean; tools: number }

declare module 'claude-code' {
  interface PluginState {
    'task-progress': {
      todos: Todo[]
      agents: AgentRow[]
      run: Run
    }
  }
}
