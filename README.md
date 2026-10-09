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

## Check the token figures

`scripts/check-usage.py` sums the usage the API reported in the session transcript, one row per prompt, so it can be compared with the bar's `turn 299.7k in (299.6k cached) · 1.1k out` line. `in` is the full input: the API's own `input_tokens` is only the fresh part, which for a long conversation is a handful of tokens because the rest is read from the cache.

```
python3 scripts/check-usage.py                # newest session of the current project
python3 scripts/check-usage.py --subagents    # also add subagent transcripts
```
