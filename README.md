# task-progress

A Claude Code mod: a progress bar above the prompt while a task runs, and an Agents pane that lists the main agent and every subagent with their tools, status and token usage.

- **Bar** follows the model's task list (`TaskCreate` / `TaskUpdate`, and `TodoWrite`); with no list it counts finished subagents. Colors are theme keys, so it follows dark / light / auto.
- **Agents pane** shows token totals (session and turn), a card for the main agent, and one for every subagent (model, effort, tools, status) with a small icon for its kind, refreshed every second. Finished subagents leave the cards and move into a short history, with the tokens they spent. `/task-agents` reopens it.

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

## Estimated cost

Token figures get an `est. $` when a price is known. The mod reads Anthropic's pricing page (`platform.claude.com/docs/en/about-claude/pricing.md`) on first use, keeps the table in the plugin store and refreshes it when it is over a day old. If the page cannot be fetched, or a model is not on it, that cost is left out and nothing else changes (a `+` after the figure means some requests had no price). It is a list-price estimate: 5-minute cache writes are assumed, and batch or priority discounts, regional pricing and subscriptions are not applied.

## Agent icons

Each card in the Agents pane shows a small emoji after its status icon, picked from the agent's type and name.

| Agent looks like | Icon | Meaning |
|---|---|---|
| coordinat | 🧭 | coordinator |
| orchestrat | 🎼 | orchestrator |
| explore, search, find | 🔍 | searches the code |
| plan, architect | 🔬 | architect / science |
| design | 📐 | designer |
| review | 🧐 | reviewer |
| test, qa | 🧪 | tester |
| secur, audit | 🔒 | security |
| research, guide, doc | 📖 | researcher / docs |
| status, config, setup | 🔩 | setup / config |
| code, coder, engineer, develop, implement, build | 💻 | engineer / coder |
| general, worker | 👷 | general-purpose worker |
| teammate | 🤝 | teammate |
| anything else | 🤖 | unknown type |

Rules are checked top to bottom against the lowercased text `<type> <name>`, the first match wins, and the main agent is always 🧠.

The table lives in the `ICON_RULES` list at the top of `hooks/register.tsx`, so it can be edited or extended there.

## Subagent history

A finished subagent (completed, failed, killed, or gone from the engine's agent list) leaves its card and becomes one line in **History**, newest first, with its status and kind icons, name, tokens, tool count, duration and description. The last 6 are shown. The heading gives the shown and finished counts, the total tokens spent by all subagents so far, and an estimated cost when a price is known; tokens are input + output, where input includes cached input. The history lasts for the session and starts empty in a new session.

```
History · 3 of 8 finished · 305.1k tok · est. $0.12
● 🔍 Explore · 101.5k tok · 0 tools · 5s · find hooks
```

## Check the token figures

`scripts/check-usage.py` sums the usage the API reported in the session transcript, one row per prompt, so it can be compared with the bar's `turn 299.7k in (299.6k cached) · 1.1k out` line. `in` is the full input: the API's own `input_tokens` is only the fresh part, which for a long conversation is a handful of tokens because the rest is read from the cache.

```
python3 scripts/check-usage.py                # newest session of the current project
python3 scripts/check-usage.py --subagents    # also add subagent transcripts
```

## Privacy and safety

- **On screen:** tool names and a short hint of each call, with secrets such as tokens, passwords, bearer headers and URL credentials redacted before it is shortened.
- **Stored** in the plugin store: `history` (tool counts and durations), `prices` and `pricesTriedAt`. No prompts and no tool arguments are persisted.
- **Network:** one GET a day to Anthropic's public pricing page with a static user-agent. It carries no user data, and nothing else is sent anywhere.
- **Read-only:** the mod only observes. It never denies, rewrites or re-runs tool calls.
