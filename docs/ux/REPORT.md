# task-progress v0.4.2: UI/UX review (dark and light)

Evidence: real captures of the plugin running in the Claude desktop app, taken in both themes (`shots/dark-*.png`, `shots/light-*.png`), pixel measurements from them, and the engine's type definitions. Mock-ups are in `band.html`, `pane.html`, `evidence.html` (rendered to `shots/*-compare.png`).

Scope limit: the captures come from the **desktop** Code tab. The CLI renders the same hooks on a monospace grid; I did not capture it, so CLI claims below rest on the code, not on a screenshot.

## Verdict

The information design is strong (one band, one pane, honest cost). The visual layer is the weak part: it looks like debug output rather than a product. Four defects are measurable, two are trust problems, and the engine already supports everything the proposed look needs.

| # | Finding | Proof | Severity |
|---|---|---|---|
| H1 | The bar sits at `~95% estimated` from the first 24 s to minute 3:39 and beyond (5 live readings, 11 to 49 calls). The app's own 5-step plan is ignored because only `TodoWrite`/`TaskCreate`/`TaskUpdate` feed it, not the desktop's `update_plan`. | `shots/evidence-compare.png` H1 | High (trust) |
| H2 | Cells are 6 px colour + 6 px empty (`{' '}` between cells, `register.tsx:1431`): half the bar is void, so it reads as a barcode. | measured run lengths, H2 | Medium |
| H3 | `claude` coral is one hex (#C6613F) in both themes: 3.78:1 on the dark band, 3.65:1 on the light band, 4.05 to 4.34 on panes. Text below 4.5:1 in both. | measured, H3 | Medium (a11y) |
| H4 | Pane lines wrap for 34 cells while the desktop pane has about 60 proportional characters of room, so "est. $0.60" is orphaned on its own line and the tool tally wraps mid-list with full `mcp__server__tool` names. | `shots/dark-pane.png`, H4 | Medium |
| H5 | Colour emoji (pink brain) next to a coral rail and a blue model name: three unrelated hues in one header. | both pane captures | Low to medium |
| H6 | Unused engine features: raw colours, `$.config.list()` theme row, `borderStyle`, `hover`, `Button`, `Image`. | `.claude-plugin/types` | Opportunity |

Also visible in the captures: the flat hierarchy of the pane (everything the same weight and size except the word "Tokens"), `(3 failed)` shown in dim grey instead of red, parallel running calls both reading "running" with no live elapsed time, and the diagnostic footer given the same space as real content.

## Design direction: "Aurora"

One idea: **a lit edge on a quiet surface.** Everything is calm and dim; only live things glow.

1. **Continuous gauge.** Adjacent background cells, no gaps. Lit cells run a coral to amber gradient (interpolated per cell in raw hex), the leading cell is a bright "glow" cell, the unlit track is a visible dim cell. Same 20 to 28 cells.
2. **Honest states** (`band.html`):
   - exact (task list): solid gradient, `40%  2/5`, current task name;
   - estimate: hatched fill (`~42%`, "est."), because it is not real progress;
   - past the cap: no bar frozen at 95 %, a 3-cell scanner and the words "no plan to measure against";
   - done: solid green, `✓ done`.
3. **Stats as a table, not a sentence.** `TURN` and `SESSION` labels in small muted caps, `in`, `cached` shown as a hit rate (`97%`, not a second 7-digit number), `out`, and the cost as the only chip. Cost is the one thing people look for.
4. **Cards with a rail.** Main agent gets the coral rail, subagents an info-blue rail, finished ones a grey rail. A `● RUNNING` status chip, effort as pips (`▮▮▮▯`), a small bar per tool in the tally (`Screenshot ▇▇▇▇▇ 9`), failures counted in red (`3 ✗`), running calls with a live elapsed time.
5. **Monochrome glyphs** (◆ main, ◈ explore, ▣ test, ◉ review) tinted by status instead of colour emoji. This also removes the emoji-width risk listed in the README.
6. **Quiet footer.** Diagnostics collapse to one dim line (`ⓘ 27/27 requests · 22 prices`); errors expand it and turn it red; `hover` reveals the detail.

Palette (raw hex, chosen per theme; ratios measured against the captured backgrounds):

| Role | Dark | Light | Ratio |
|---|---|---|---|
| Accent text, rail | #E07A55 | #B04A2A | 5.17 / 4.90 |
| Gradient end | #F2A07B | #D9822B | graphic |
| Glow cell | #FFD9BF | #8A2F10 | graphic |
| Track | #3A3A3A | #D8D8D8 | 1.35 / 1.39 (decorative) |
| Muted text | #A1A1A1 | #616161 | 5.93 / 5.58 (unchanged) |
| Info (model, effort) | #6AABF1 | #1757AC | 7.29 / 7.01 (unchanged) |

## How to build it (all inside `hooks/register.tsx`)

| Priority | Change | Where | Effort |
|---|---|---|---|
| P0 | Feed the task list from `mcp__ccd_turn__update_plan` (its `items`, `advance`, `done`, `start` shapes) as well as `TodoWrite`/`TaskCreate`/`TaskUpdate`; past the cap use the scanner. | `tool.call` hooks near line 1330, `estimate()` line 553, band render line 1397 | S to M |
| P0 | Remove the `{' '}` gap cells; add gradient, glow cell, visible track. | band render, lines 1421 to 1432 | S |
| P1 | Theme palette: read the `theme` row with `$.config.list()` at `session.start` and on `config.set`; map to the dark or light table above; fall back to today's theme keys when the theme is `auto`, `ansi` or unknown. Colour-blind and ANSI themes keep theme keys. | new `palette()` helper, replaces `PALETTE`/`COLOR` lookups | M |
| P1 | Pane layout with `Box` columns (`width`, `flexGrow`, `justifyContent`) so the engine measures the width; keep `pack()` only for the CLI path. Shorten `mcp__server__tool` to `tool` plus a dim server tag. | pane render lines 1463 to 1749, `tallySegs` | M |
| P2 | Cards with rail, status chip, effort pips, tool bars, red failure count, live elapsed for running calls. | pane render | M |
| P2 | Monochrome kind glyphs replacing `ICON_RULES` emoji; keep the rule table, change the values; update README table. | lines 123 to 146 | S |
| P3 | `Button` to fold History, `hover` to reveal diagnostics and full tool names, optional `Image` sparkline on kitty/Ghostty with `alt` elsewhere. | pane | M |

Rules from `CLAUDE.md` still apply: new inputs go through `clean`/`num`, new colours come from a fixed table (never from model text), hooks keep their `try/catch`, and tests in `ledger.test.tsx`, `register.test.tsx`, `narrow-pane.test.tsx` need cases for the new states (scanner, theme fallback, narrow pane with chips). Bump `version` in `plugin.json` with the first visible change.

## Risks and open questions

- Raw hex does not adapt by itself. Proposal depends on reading the theme; if `$.config.list()` is unavailable on some surface, fall back to theme keys (today's behaviour).
- I inferred H4's cause (cell counting on a proportional font) from the code and the outcome; I did not log what `bodyColumns` reports on desktop. A one-line debug of `e.props.bodyColumns` would confirm it before the layout rewrite.
- Hatching and glow are cell backgrounds and bold; they need a check on 16-colour terminals and Windows Terminal's default font.
- `Image` support differs per surface (kitty/Ghostty only in the terminal); treat it as optional.
- The mock-ups are drawn in HTML, not produced by the plugin. They show intent, not final pixels.

## Files

- `shots/dark-band.png`, `shots/light-band.png`, `shots/dark-pane.png`, `shots/light-pane.png`, `shots/*-window.png`: real captures
- `shots/band-compare.png`, `shots/pane-compare.png`, `shots/evidence-compare.png`: rendered comparisons
- `band.html`, `pane.html`, `evidence.html`, `styles.css`: sources of the mock-ups
