# task-progress

A Claude Code mod: a progress bar above the prompt while a task runs, and a pane that lists subagents with their statuses.

- **Bar** follows the model's task list (`TaskCreate` / `TaskUpdate`, and `TodoWrite`); with no list it counts finished subagents. Colors are theme keys, so it follows dark / light / auto.
- **Pane** lists every subagent (icon, description, type, status), refreshed every second. `/task-agents` reopens it.

## Install

```
/plugin install task-progress --marketplace <owner>/task-progress
```

Answer `y` to add the marketplace, then choose the user scope. Run it from a terminal session; the desktop Code tab does not offer the command.

Without installing: `claude --plugin-dir /path/to/task-progress`.

## Develop

```
claude plugin validate .
claude plugin test .
```
