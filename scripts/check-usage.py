#!/usr/bin/env python3
"""Ground truth for the token figures in the task-progress bar and pane.

Sums the API-reported usage that Claude Code records in a session transcript,
one row per prompt (what the bar calls "turn"), plus a session total. Compare
a row with the bar's `turn ... in · ... out · ... cached` line.

  python3 scripts/check-usage.py                 # newest session of the cwd's project
  python3 scripts/check-usage.py <session-id>    # a given session
  python3 scripts/check-usage.py --subagents     # also add subagent transcripts

Notes: the API's own `input_tokens` is only the fresh part of the input (a long
conversation reads "2"), so `in` here, like the bar, is the full input: fresh +
cache reads + cache writes, with `cached` the cache-read part of it. A message
is counted once even when the transcript splits it over several lines.
"""
import glob, json, os, sys

def transcripts(session):
    base = os.path.expanduser("~/.claude/projects")
    if session:
        return sorted(glob.glob(f"{base}/*/{session}.jsonl"))
    proj = "-" + os.getcwd().strip("/").replace("/", "-").replace("_", "-")
    found = sorted(glob.glob(f"{base}/{proj}/*.jsonl"), key=os.path.getmtime)
    return found[-1:]

def load(path):
    rows = []
    for line in open(path):
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
    return rows

def k(n):
    return str(n) if n < 1000 else f"{n/1000:.1f}k" if n < 1_000_000 else f"{n/1_000_000:.1f}M"

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    with_sub = "--subagents" in sys.argv
    files = transcripts(args[0] if args else None)
    if not files:
        sys.exit("no transcript found")
    rows = []
    for f in files:
        rows += load(f)
    rows.sort(key=lambda r: r.get("timestamp", ""))

    turns, cur, seen = [], None, set()
    for r in rows:
        msg = r.get("message") or {}
        if r.get("type") == "user" and not r.get("isSidechain"):
            c = msg.get("content")
            text = c if isinstance(c, str) else "".join(
                b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"
            ) if isinstance(c, list) else ""
            is_result = isinstance(c, list) and any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in c
            )
            if text.strip() and not is_result and not text.startswith("<"):
                if cur is not None and cur["req"] == 0:
                    turns.pop()  # a prompt with an image arrives as two user lines
                cur = {"p": text.strip().replace("\n", " ")[:44], "t": r.get("timestamp", "")[11:19],
                       "in": 0, "out": 0, "cr": 0, "cw": 0, "req": 0}
                turns.append(cur)
        elif r.get("type") == "assistant" and cur is not None and not r.get("isSidechain"):
            u, mid = msg.get("usage"), msg.get("id")
            if u and mid and mid not in seen:
                seen.add(mid)
                cur["in"] += u.get("input_tokens", 0)
                cur["out"] += u.get("output_tokens", 0)
                cur["cr"] += u.get("cache_read_input_tokens", 0)
                cur["cw"] += u.get("cache_creation_input_tokens", 0)
                cur["req"] += 1

    sub = {"in": 0, "out": 0, "cr": 0, "cw": 0}
    if with_sub:
        for f in files:
            for sf in glob.glob(f[:-6] + "/subagents/*.jsonl"):
                ids = set()
                for r in load(sf):
                    msg, u = r.get("message") or {}, (r.get("message") or {}).get("usage")
                    if r.get("type") == "assistant" and u and msg.get("id") not in ids:
                        ids.add(msg.get("id"))
                        sub["in"] += u.get("input_tokens", 0); sub["out"] += u.get("output_tokens", 0)
                        sub["cr"] += u.get("cache_read_input_tokens", 0); sub["cw"] += u.get("cache_creation_input_tokens", 0)

    print(f"{'time':8} {'req':>3}  {'in':>7} {'(cached)':>9} {'out':>7}  {'(fresh)':>8}  prompt")
    tot = {"in": 0, "out": 0, "cr": 0, "cw": 0}
    for t in turns:
        full = t["in"] + t["cr"] + t["cw"]
        print(f"{t['t']:8} {t['req']:>3}  {k(full):>7} {k(t['cr']):>9} {k(t['out']):>7}  {k(t['in']):>8}  {t['p']}")
        for key in tot:
            tot[key] += t[key]
    for key in tot:
        tot[key] += sub[key]
    label = "session total (main + subagents)" if with_sub else "session total (main agent only)"
    full = tot["in"] + tot["cr"] + tot["cw"]
    print(f"\n{label}: {k(full)} in ({k(tot['cr'])} cached) · {k(tot['out'])} out")

main()
