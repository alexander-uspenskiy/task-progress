# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code **mod** (plugin made of function hooks), not a normal Node app: there is no `package.json`, no bundler and no build step. The engine loads `hooks/register.tsx` directly (`hooks/hooks.json` is just `{ "modules": ["./register.tsx"] }`). The `claude-code` and `claude-code/testing` imports exist only inside the engine, so nothing here runs under plain `node` or `tsc`. The mod draws a progress band above the prompt and an "Agents" pane (main agent, subagents, tokens, estimated cost). README.md documents the user-facing behavior, constants and limitations in detail.

## Commands

```bash
claude plugin validate .      # check the manifest and hooks
claude plugin test .          # run every *.test.ts(x) under the folder, each file in its own child process
claude --plugin-dir .         # try the mod without installing it
python3 scripts/check-usage.py [session-id] [--subagents]   # ground truth for the token figures, from a session transcript
```

`claude plugin test` takes a folder, not a file, so there is no built-in single-test flag. Tests import `test`, `expect` and `mock` from `claude-code/testing`.

Needs a recent Claude Code (2.1.80 cannot read this plugin format; developed on 2.1.293–2.1.295). `.claude-plugin/types/` and `tsconfig.json` are written by the engine on every load and are git-ignored; don't edit them.

Releasing: an installed copy only sees an update when `version` in `.claude-plugin/plugin.json` changes, so bump it with any user-visible change (and update README when behavior or limitations change).

## Architecture

Almost everything is in `hooks/register.tsx` (state atoms and pure helpers at the top, then the `register` function with all hooks at the bottom). `types/index.d.ts` is the state contract: it declares `PluginState['task-progress']`, and atom keys must match it.

**State has two layers.**
- *Engine atoms* (in memory, via `atom`/`read`/`update`): `todos`, `calls` (last 400), `agents`, `roster1` (subagent seats, last 40), `setups` (model and effort per agent), `run`, `diag2`, `prices1`, and `ledger1`. Atom keys are versioned (`ledger1`, `roster1`, `prices1`, `diag2`); change the shape of one and bump its key (and the `types/index.d.ts` entry) so state from older builds is not carried over.
- *Plugin store* (`$.store`, survives reloads): `history` (last 20 turns' tool count and seconds, used for the no-task-list estimate), `prices`, `pricesTriedAt`, and `ledger:<session id>` (8 most recent sessions; the current one is deleted on `session.end`).

**The token ledger is one atom on purpose.** `ledger1` holds `turn`, per-`agents` totals, `retired` (agents pruned by the cap) and `seen` (what each turn's own requests already counted) so the parts can never disagree. Every write goes through `tally`, in a single `update`, and every write path (`count`, `reconcile`, `creditTranscript`, `saveLedger`) first awaits `adopt`, which takes the saved copy back once per load of the mod and session: a reload mid-turn empties the in-memory ledger, and without `adopt` the next save would overwrite the saved totals with only what came after. Tokens reach it three ways, and each must add only the *difference* from what is already counted, never the full figure, to avoid double counting:
1. `turn.step` (per model request, via `count`),
2. `turn.complete` (`reconcile`: adds what the requests missed, using `seen`),
3. subagent transcripts (`creditTranscript`, triggered by `classic.SubagentStop`, by `classic.Stop` with the session transcript path, and by `backfillSeats` on a poll or prompt) because subagent requests may never reach the hooks.

**Hook flow.** `prompt.submit` starts or continues a turn (a prompt sent within 10 s of the last poll while a run is active continues the same turn), opens the pane, starts the 400 ms `tick` poll (which stops itself when nothing is running), and appends `TASK_HINT` to the prompt context. `tool.call` logs calls; the `TodoWrite`/`TaskCreate`/`TaskUpdate` variants also feed `todos`. `turn.complete` with no `agentId` ends the main run, but the poll then carries on (`startTick`) while any subagent is unfinished, because a main turn can end first (a background subagent: the Agent call returns at once and the main agent waits for its report); `turn.complete` with an `agentId` (and `classic.SubagentStop`, which the desktop app may skip) marks that subagent stopped (`markStopped`) so `refresh` shows it finished even while the engine's list still says running, until a `turn.step` of its own says otherwise. `session.end` (also fired by `/clear`, which fires no `session.start`) stops all timers first and then resets state. `ui.render` has two handlers: `AbovePrompt` (the band) and `Pane` (requestId `task-agents`), both pure reads of atoms.

**Progress source priority** (`measure`/`estimate`): task list if any, else finished-subagent count, else a `~` estimate from the median of past turns, capped at 95%.

## Conventions that matter when editing

- **Everything not produced by this file is hostile input**: the pricing page, subagent transcripts, store contents, and model-chosen text (commands, agent and task names, model ids, errors). Numbers go through `num`/`cap`, stored objects through `norm`/`cleanTok`/`cleanPrices`/`cleanHistory`, display strings through `clean` (strips control and bidi characters, clamps length), ids through `isSafeId`/`isSafeName` before they become part of a file path. Regexes must stay linear-time (no nested quantifiers; open-ended ones bounded). The tests in `hostile-input.test.tsx`, `sanitize.test.tsx` and `redact*.test.tsx` enforce this; add a case there when you add an input.
- **Bookkeeping after `next(e)` must never throw into `.catch(...next(e))`**: that calls `next` a second time and could run a tool twice. Every post-`next` block (TaskCreate, TaskUpdate, update_plan, wrap_up, turn.complete) is wrapped in try/catch and returns the original result. Task subjects and agent descriptions go through `safeLabel` (clean plus `SECRET_SHAPES`), not full `redact`, so ordinary names such as "Fix password: reset flow" stay readable.
- **Hints are redacted before they are shortened** (`redact`, then cut to 36 chars) because they appear on screen and live in state. Redaction is best effort; extend `SECRET_SHAPES`/`SENSITIVE_*` rather than special-casing.
- **Hooks must never break the host.** Bookkeeping after `next(e)` is wrapped in `try/catch`, most hooks end with `.catch(($, e, next) => next(e))`, and slow work (price fetch, transcript reads) runs from a `$.clock.after(0, …)` timer so it never holds up a prompt or stop event. Timers are tracked (`tick`, `pricing`, `backfill`, `jobs`) and cancelled in `session.end`; the module-level `endedId` guard stops a late save from re-creating a deleted ledger key.
- The mod only observes; it never denies or rewrites tool calls. Its single change to a prompt is `TASK_HINT`.
- Cost uses list prices parsed from `platform.claude.com/docs/en/about-claude/pricing.md` (the only network call, one a day). A model with no price shows no cost, and a `+` after the figure marks partial pricing. All cache writes are priced at the 5-minute rate.
- `$.fs.read` has a 4 MiB limit and no ranged read, so larger subagent transcripts are skipped (`TRANSCRIPT_LIMIT`).
- Agent icons (`ICON_RULES`) must be one-cell monochrome symbols from the Basic Multilingual Plane (`◈ ◉ ▣ …`), never colour emoji: they take the colour of the status marker and keep their width. `cells()` counts anything from U+1F000 up as two cells.
- Colors are engine theme keys (`claude`, `claudeShimmer`, `userMessageBackground`, `professionalBlue`, `inactive`, `success`, …), never hex: the CLI and the desktop app map the same key to their own value, so a key adapts to dark and light where a fixed hex cannot. The CLI's theme tables (all keys per theme) are strings inside its `claude.exe`.
- The engine only lets `$` be passed to functions declared at the top of `register.tsx` (a function declaration or a const bound to one), never to a closure inside `register`; helpers that take `$` (`startTick`, `isSubagentBusy`, `adopt`, and so on) and the state they share (`tick`) live at module level.
- Tests that compare file paths go through `posix()` (see `hostile-input.test.tsx`): the engine hands paths over as the host resolves them, so on Windows `/p/a.jsonl` arrives with a drive letter and backslashes.
- Do not type `\uXXXX` escapes of control or bidi characters through a tool argument: they arrive as the literal character. Build such test strings with `String.fromCharCode` or `\u{...}` built from parts.

## Tests

`hooks/*.test.tsx` use a stub engine (see the top of `ledger.test.tsx` for the `AbovePrompt` and `Pane` render fixtures and the usage helper). Files are split by concern: band and estimate and pane (`register`), ledger and restore, subagent transcripts, network and lifecycle (timers, price fetch, `/clear`), redaction, sanitizing, and hostile input.
