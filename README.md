# task-progress

A Claude Code mod (a plugin made of function hooks) that draws a progress band above the prompt while a task runs and an "Agents" pane that lists the main agent and every subagent with their tools, status, model, effort and token usage. Token figures carry an estimated cost taken from Anthropic's published list prices.

It only observes. It does add one fixed reminder to each prompt (see [How it works](#how-it-works)).

## What you get

- **Progress bar** above the prompt while a task runs: 20 segments, coral fill on a dark track. Colors are theme keys, so it follows the dark, light and auto themes.
- **Real progress when there is a task list.** The bar follows the model's own list (`TaskCreate` / `TaskUpdate` and `TodoWrite`). With no list it counts finished subagents if there are any, and otherwise shows an estimate (`~42%`, never above 95%) learned from the median tool-call count and duration of your past turns.
- **Token row** under the bar: `turn ... · session ...`, with `in` (fresh + cache reads + cache writes, the cached part in brackets), `out`, and an estimated cost.
- **Agents pane**, opened by a prompt and by `/task-agents`: session and turn totals, a Main agent card, a card per running subagent, and a short History of finished subagents.
- **Kind icons** for agents (explore, plan, review, test, and so on), picked from the agent's type and name.

## What it looks like

The band. Each segment is a colored cell in the terminal; `█` is lit and `░` is the track:

```
█ █ █ █ █ █ █ █ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░  ~42% · 0:48 · 9 tool calls · estimated
turn 24.8k in (24.1k cached) · 1.9k out · est. $0.03 · session 310.5k in (298.0k cached) · 6.2k out · est. $0.41
```

With a task list the percent is exact and the current task is named:

```
█ █ █ █ █ █ █ █ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░ ░  40%  2/5 · 1:12 · Write the tests
```

The pane (numbers are illustrative):

```
Tokens
  session (all agents)
    1.4M in (1.3M cached) · 11.2k out · est. $2.31
  this turn
    312.0k in (305.4k cached) · 2.6k out · est. $0.52

▌ 🧠 Main agent  sonnet-5-5 · effort high
    9.8k tok · 7.9k in (7.1k cached) · 1.9k out · est. $0.11
    14 tools · Read×6 Bash×4 Edit×3 Grep×1
    ✓ Edit hooks/register.tsx · 120ms
    ◐ Bash npm test · running

Subagents · 3 total · 1 active
◐ 🔍 Explore (find hooks)
    a1b2c3d4 · running · haiku-5-5 · effort low
    5 tools · 101.5k tok · 100.9k in (96.0k cached) · 0.6k out · est. $0.03
    ✓ Grep register · 0.3s

History · 2 of 2 finished · 305.1k tok · est. $0.12
● 🧪 Tester · sonnet-5-5 · 203.6k tok · est. $0.09 · 12 tools · 1m05s · run the suite
● 🧐 Reviewer · sonnet-5-5 · 101.5k tok · est. $0.03 · 3 tools · 5s · review the diff

counted: 41/41 requests (12 from subagents) · 3 turns · 2 subagent transcripts · 94 prices
```

Model and effort show in their own color, and the estimated cost is bold. The last line is a diagnostic: requests that carried usage, subagent requests, closing reports, transcripts read, and prices known.

## How it works

All of it lives in `hooks/register.tsx`.

| Piece | What it does |
|---|---|
| `prompt.submit` | Starts a turn (clears the turn totals, sets the estimate from past turns), opens the pane, starts a 400 ms poll that stops when nothing is running, loads prices, and adds a fixed reminder to the prompt context. A prompt sent while a run is still going continues the same turn. |
| `tool.call` | Logs every call of the main agent and subagents (running, then done or error, with duration). `TodoWrite`, `TaskCreate` and `TaskUpdate` calls also feed the task list. |
| `turn.step` | Records each request's model and effort (effort is only known here) and adds its token usage to the ledger. |
| `turn.complete` | The turn's closing report adds whatever the requests missed, saves the ledger, and for a main turn records its tool count and duration for the estimate. |
| `agent.spawn`, `classic.SubagentStop`, `classic.Stop` | Learn a subagent's model at spawn; read a subagent's own transcript when it stops; read transcripts of finished subagents at the end of a main turn. |
| `session.start`, `session.end` | Start: restore the ledger, backfill, fetch prices, register `/task-agents`. End (also `/clear`): stop timers, clear all figures. |
| `ui.render` | `AbovePrompt` draws the band (hidden when no task is running and no listed task is open); `Pane` draws the Agents pane. |

**Reminder added to each prompt.** The text is `Reminder: the user has a progress bar above the prompt that follows your task list. For work with three or more steps, create the steps first with TaskCreate (one short subject each), mark each in_progress when you start it and completed when it is done with TaskUpdate, so the bar shows real progress.` It is the constant `TASK_HINT`. This changes what the model is told on every prompt; remove it if you do not want that (see Configuration).

**Where state lives.**

- Engine state atoms (in memory): task list, agent list, the subagent roster (last 40), the tool-call log (last 400), model and effort per agent, the run clock, and the token ledger.
- Plugin store (kept across reloads): `history` (tool count and seconds of your last 20 turns, used for the estimate), `prices` and `pricesTriedAt`, and `ledger:<session id>` (token counters of the 8 most recent sessions; the current one is deleted on `session.end`).

**Tokens.** Counted per model request from `turn.step`, for the main agent and, when they reach the hooks, subagents. A turn's closing report fills in anything the requests missed. A subagent's tokens are read from its own transcript when it stops, and finished subagents with no tokens counted are backfilled from the session folder `~/.claude/projects/<project>/<session>/subagents/` at load, on each prompt, on each poll (a few tries, spaced out), and at the end of a turn. Only the difference from what was already counted is added. The ledger is saved to the store (at most every 2 s, and at the end of a turn or subagent) and restored if the in-memory copy is empty after a reload.

**Estimated cost.** On first use the mod fetches `platform.claude.com/docs/en/about-claude/pricing.md` (8 s timeout, run from a timer so it never holds up a prompt), parses the model table, keeps it in the store, and refreshes it when it is over a day old; a failed attempt is not retried within the hour. Each request is priced at its model's list rate, using the long-prompt rate when the page lists one and the prompt is over its limit. If a model has no price, or the fetch failed, that cost is left out; a `+` after the figure means some requests had no price.

**Subagent history.** A subagent is moved from its card into History when it completes, fails, is killed, or disappears from the engine's agent list. The last 6 are shown, newest first; the heading gives how many are shown and finished, the tokens of all subagents so far, and their estimated cost.

## Install and update

Needs a recent Claude Code: the 2.1.80 CLI cannot read this plugin format, and development and the tests ran on 2.1.293 to 2.1.295.

```
claude plugin marketplace add alexander-uspenskiy/task-progress
claude plugin install task-progress@task-progress --scope user
```

The desktop Code tab does not offer the `/plugin install` command but loads user-scope plugins, so install from the CLI. To update:

```
claude plugin update task-progress@task-progress
```

An update only sees a release when `version` in `.claude-plugin/plugin.json` changes. To try it without installing: `claude --plugin-dir /path/to/task-progress`.

## Using it

- Send a prompt. The pane opens and the band appears above the prompt while the run is active. The band stays while listed tasks are still open, and hides when everything is done or a survey is showing.
- For a task of three or more steps the model is asked to create a task list, and the bar then shows `done/total` and the name of the task in progress. The next segment blinks while the run is active.
- `/task-agents` opens the pane again at any time.
- In the pane: totals first, then the Main agent (model, effort, tokens, a tally of its tools, its last calls with status and duration), then a card per running subagent (status icon, kind icon, name and description, short id, status, model, effort, tool count, tokens, last calls), then History. The pane trims cards to fit its height and says how many older agents are not shown.
- Status markers: `○` pending, `◐` running, `◔` waiting, `◌` idle, `●` completed, `✗` failed or killed.
- `/clear` ends the session for the mod and resets every figure; saved prices are kept.

Agent kind icons come from `ICON_RULES`, tested top to bottom against the lowercased `<type> <name>`; the first match wins.

| Text matches | Icon | Text matches | Icon |
|---|---|---|---|
| coordinat | 🧭 | research, guide, doc | 📖 |
| orchestrat | 🎼 | status, config, setup | 🔩 |
| explor, search, find | 🔍 | code, coder, engineer, develop, implement, build | 💻 |
| plan, architect | 🔬 | general, worker | 👷 |
| design | 📐 | teammate | 🤝 |
| review | 🧐 | main agent | 🧠 |
| test, qa | 🧪 | anything else | 🤖 |
| secur, audit | 🔒 | | |

## Configuration

There is no `userConfig`. Change behavior by editing constants in `hooks/register.tsx` and restarting Claude Code.

| Constant | Controls |
|---|---|
| `SEGMENTS` | Number of bar segments (20). |
| `PALETTE`, `COLOR` | Theme keys for the bar and for status colors. |
| `SETUP_COLOR` | Color of model and effort (`suggestion`). |
| `HISTORY_DONE_COLOR`, `HISTORY_SHOWN` | Color of finished markers in History; how many history lines are shown (6). |
| `ICON_RULES`, `MAIN_ICON`, `OTHER_ICON`, `ICON` | Agent kind icons, the main and fallback icons, status markers. |
| `TICK_MS` | Poll interval of the band and pane data (400 ms). |
| `TASK_HINT` | The reminder added to each prompt. Edit the text, or remove the `context` line at the end of the `prompt.submit` hook to stop adding it. |
| `PRICING_URL`, `FETCH_TIMEOUT_MS` | Where prices come from and how long the fetch may take. |
| `KEEP_AGENTS`, `KEEP_SAVED` | How many agents are kept in the ledger, and how many sessions' ledgers are kept in the store. |

Keep icons single code point emoji, as the file comment says, so they keep their width.

## Requirements and limitations

- **The percentage without a task list is a guess.** It uses the median tool calls and duration of your last 20 turns (defaults of 8 calls and 60 s until there is history), is marked `~` and `estimated`, and stops at 95% so it only finishes when the turn does.
- **Cost is a list-price, API-equivalent estimate.** It is not what a subscription pays. Cache writes are all priced at the 5-minute rate because the engine reports one cache-write count with no 5m/1h split. Batch or priority discounts, regional pricing and subscriptions are not applied. It is left out for models with no price, and the pricing page layout may change.
- **Subagent requests may not reach the hooks.** Their tokens then come from their own transcript when they stop (or when backfilled), so they can appear later than the work. Effort is only known for agents whose requests reach the hooks; others show a model and no effort. Without the transcript folder, `HOME`, or readable files, a subagent's tokens stay uncounted.
- A fixed reminder is added to every prompt, which is a visible behavior change in what the model sees.
- Tokens are counted per request and reconciled with the turn's closing report; an aborted turn adds nothing from that report.
- Long agent names and hints are cut at the pane's edge; hints are shortened to 36 characters.
- Terminal and desktop: the pane and band are drawn by the Claude Code UI; the desktop Code tab loads user-scope plugins but lacks the install command.
- Emoji width depends on the terminal font. Single code point emoji were chosen to keep alignment, but some terminals still draw them wide or narrow.

## Privacy and safety

- **Read-only:** the mod only observes. It never denies, rewrites or re-runs tool calls. Its one change to a prompt is the reminder described above.
- **On screen:** tool names and a short hint of each call. The hint is redacted before it is shortened (tokens, passwords, bearer headers, well-known key shapes, URL credentials and query strings), but redaction is best effort and does not catch every secret shape, for example `curl -u user:pass`. Agent descriptions and task names are shown as they are. Hints are kept in the mod's state, not in the plugin store. Do not share screenshots of the pane from sessions that handle secrets.
- **Stored** in the plugin store: `history` (tool counts and durations), `prices`, `pricesTriedAt`, and the token ledger per session (counters only). No prompts and no tool arguments are persisted there.
- **Network:** one GET a day to Anthropic's public pricing page with a static user-agent. It carries no user data, and nothing else is sent anywhere.
- The pricing page is treated as untrusted input: only its first 400,000 characters are read, long lines are skipped, at most 200 rows are kept, and prices outside 0 to 1000 USD per million tokens are dropped.

## Check the numbers

`scripts/check-usage.py` sums the usage the API reported in a session transcript, one row per prompt, so you can compare it with the bar's `turn` line. `in` is the full input; the API's own `input_tokens` is only the fresh part.

```
python3 scripts/check-usage.py                # newest session of the current project
python3 scripts/check-usage.py <session-id>   # a given session
python3 scripts/check-usage.py --subagents    # also add subagent transcripts
```

It prints time, requests, in, cached, out, fresh input, estimated cost and the prompt text, then a session total. For the estimated cost it makes its own GET to the same pricing page; without network the cost column is left out.

## Development and tests

```
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx`: the whole mod.
- `hooks/*.test.tsx`: tests (band and estimate, pane, icons, history, ledger and restore, subagent transcripts, price parsing and hostile pages, redaction, timers and `/clear`).
- `types/index.d.ts`: the state contract (`PluginState['task-progress']`).
- `.claude-plugin/plugin.json` and `marketplace.json`: manifest and marketplace entry. `.claude-plugin/types/` is written by the engine on every load and is git-ignored.

## License

MIT. See the `LICENSE` file.
