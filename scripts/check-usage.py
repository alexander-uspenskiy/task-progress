#!/usr/bin/env python3
"""Ground truth for the token figures in the task-progress bar and pane.

Sums the API-reported usage that Claude Code records in a session transcript,
one row per prompt (what the bar calls "turn"), plus a session total. Compare
a row with the bar's `turn ... in · ... out · ... cached` line.

  python3 scripts/check-usage.py                 # newest session of the cwd's project
  python3 scripts/check-usage.py <session-id>    # a given session
  python3 scripts/check-usage.py --subagents     # also add subagent transcripts

The est. $ column prices every request at Anthropic's list prices (the page the
mod reads); with no price for a model, or no network, it is left out.

Notes: the API's own `input_tokens` is only the fresh part of the input (a long
conversation reads "2"), so `in` here, like the bar, is the full input: fresh +
cache reads + cache writes, with `cached` the cache-read part of it. A message
is counted once even when the transcript splits it over several lines.
"""
import glob, json, os, re, sys, urllib.request

PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing.md"

def load_prices():
    """The same table the mod reads. Any failure -> no prices -> no cost column."""
    try:
        req = urllib.request.Request(PRICING_URL, headers={"User-Agent": "task-progress-mod (check-usage script)"})
        md = urllib.request.urlopen(req, timeout=15).read().decode()
    except Exception:
        return {}
    rows = {}
    num = lambda c: float(re.search(r"\$([\d.]+)", c).group(1)) if re.search(r"\$([\d.]+)", c) else None
    for ln in md.splitlines():
        if not ln.startswith("| Claude"):
            continue
        c = [x.strip() for x in ln.strip().strip("|").split("|")]
        if len(c) < 6:
            continue
        label = re.sub(r"\[(.*?)\]\(.*?\)", r"\1", c[0])
        name = re.sub(r"\([^)]*\)", "", label).strip().lower()
        name = re.sub(r"^claude\s+", "", name)
        p = [num(x) for x in c[1:6]]
        if None in p:
            continue
        over = re.search(r"over ([\d,]+) tokens", label)
        rows.setdefault("claude-" + re.sub(r"[\s.]+", "-", name), []).append(
            {"in": p[0], "w5": p[1], "cr": p[3], "out": p[4], "over": int(over.group(1).replace(",", "")) if over else None})
    return rows

def cost(prices, model, fresh, read, write, out):
    """Estimated USD at list price, 5-minute cache writes assumed; None without a price."""
    mid = re.sub(r"-\d{8}$", "", re.sub(r"\[.*\]$", "", (model or "").lower()))
    rows = prices.get(mid)
    if not rows:
        return None
    prompt = fresh + read + write
    row = next((r for r in rows if r["over"] is not None and prompt > r["over"]), None) or next(r for r in rows if r["over"] is None) if any(r["over"] is None for r in rows) else rows[0]
    return (fresh * row["in"] + write * row["w5"] + read * row["cr"] + out * row["out"]) / 1e6

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

    prices = load_prices()
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
                       "in": 0, "out": 0, "cr": 0, "cw": 0, "req": 0, "usd": 0.0, "unpriced": 0}
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
                usd = cost(prices, msg.get("model"), u.get("input_tokens", 0), u.get("cache_read_input_tokens", 0),
                           u.get("cache_creation_input_tokens", 0), u.get("output_tokens", 0))
                if usd is None:
                    cur["unpriced"] += 1
                else:
                    cur["usd"] += usd

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

    print(f"{'time':8} {'req':>3}  {'in':>7} {'(cached)':>9} {'out':>7}  {'(fresh)':>8} {'est. $':>8}  prompt")
    tot = {"in": 0, "out": 0, "cr": 0, "cw": 0}
    for t in turns:
        full = t["in"] + t["cr"] + t["cw"]
        usd = "-" if not prices or t["usd"] == 0 else f"{t['usd']:.2f}" + ("+" if t["unpriced"] else "")
        print(f"{t['t']:8} {t['req']:>3}  {k(full):>7} {k(t['cr']):>9} {k(t['out']):>7}  {k(t['in']):>8} {usd:>8}  {t['p']}")
        for key in tot:
            tot[key] += t[key]
    for key in tot:
        tot[key] += sub[key]
    label = "session total (main + subagents)" if with_sub else "session total (main agent only)"
    full = tot["in"] + tot["cr"] + tot["cw"]
    total_usd = sum(t["usd"] for t in turns)
    est = f" · est. ${total_usd:.2f} (list prices, 5-minute cache writes)" if prices and total_usd else " · no prices available"
    print(f"\n{label}: {k(full)} in ({k(tot['cr'])} cached) · {k(tot['out'])} out{est}")

main()
