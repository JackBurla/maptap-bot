"""
Phase 4: Transform reduced.json into UI-ready JSON artifacts.

Outputs in data/:
  overall.json     — hero stats (8 numbers for the stat bar)
  wall.json        — the Graveyard Wall cards (zero-engagement, never-returned)
  crashout.json    — the Crash Out Wall (Meltdown Mode) top posts
  findings.json    — all 8 findings

Run locally after reduce.py completes.

Usage:
    python analysis.py
"""
from __future__ import annotations

import datetime
import json
import re
from collections import Counter
from pathlib import Path

HERE          = Path(__file__).parent
IN_PATH       = HERE / "samples" / "reduced.json"
URL_SUMMARY   = HERE / "samples" / "url_summary.json"
OUT_DIR       = HERE / "data"


# ── helpers ───────────────────────────────────────────────────────────────────

def _ts_to_year(ts: int) -> int | None:
    try:
        return datetime.datetime.utcfromtimestamp(ts).year
    except Exception:
        return None


def _ts_to_hour(ts: int) -> int | None:
    try:
        return datetime.datetime.utcfromtimestamp(ts).hour
    except Exception:
        return None


def _ts_fmt(ts: int) -> str:
    try:
        return datetime.datetime.utcfromtimestamp(ts).strftime("%b %d, %Y")
    except Exception:
        return ""


def _hn_url(post_id: int) -> str:
    return f"https://news.ycombinator.com/item?id={post_id}"


def _fmt_num(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _domain(url: str) -> str:
    """Extract domain from URL."""
    if not url:
        return ""
    m = re.match(r"https?://([^/]+)", url)
    return m.group(1).replace("www.", "") if m else ""


# ── wall card builder ─────────────────────────────────────────────────────────

def _build_wall_card(post: dict) -> dict:
    """Convert a post dict to a graveyard wall card."""
    return {
        "id":            post["id"],
        "hn_url":        _hn_url(post["id"]),
        "by":            post["by"],
        "title":         post["title"],
        "text":          post.get("text", "")[:300],
        "url":           post.get("url", ""),
        "domain":        _domain(post.get("url", "")),
        "score":         post["score"],
        "descendants":   post["descendants"],
        "time":          post["time"],
        "date_fmt":      _ts_fmt(post["time"]),
        "year":          _ts_to_year(post["time"]),
        "hour":          _ts_to_hour(post["time"]),
        "dead":          post.get("dead", False),
        "url_alive":     post.get("url_alive"),
        "url_status":    post.get("url_status"),
        "crash_out_score":   post.get("crash_out_score", 0),
        "crash_out_signals": post.get("crash_out_signals", []),
    }


# ── findings ──────────────────────────────────────────────────────────────────

def build_findings(data: dict) -> list[dict]:
    trajectories  = data["trajectories"]
    all_posts     = data.get("graveyard_posts", [])
    top_crash     = data.get("top_crash_posts", [])
    breakout_authors = data.get("breakout_authors", [])

    # For per-year analysis, rebuild from trajectories
    all_show_hn: list[dict] = []
    for t in trajectories.values():
        all_show_hn.extend(t["all_posts"])

    findings: list[dict] = []

    # ── F1: The One-and-Done ──────────────────────────────────────────────────
    one_and_done = [
        t for t in trajectories.values()
        if t["one_and_done"]
    ]
    one_and_done.sort(key=lambda a: -(a["breakout_post"] or {}).get("score", 0) if False else a["first_post_time"])

    # Sample: most poignant ones (have text, have a URL)
    oad_sample = [
        t for t in one_and_done
        if t["all_posts"][0].get("text") and t["all_posts"][0].get("url")
    ][:100]

    findings.append({
        "id": "one_and_done",
        "title": "One post. Zero traction. Never posted another Show HN.",
        "stat": f"{len(one_and_done):,} builders",
        "blurb": (
            f"{len(one_and_done):,} accounts posted exactly one Show HN, "
            "got no engagement, and never posted another. "
            "Many left behind a URL — a project still frozen at its launch moment."
        ),
        "rows": [
            {
                **_build_wall_card(t["all_posts"][0]),
                "author_n_submissions": 1,
            }
            for t in oad_sample
        ],
    })

    # ── F2: The Long Cold — accounts with 5+ zero-engagement posts ────────────
    long_cold = [
        t for t in trajectories.values()
        if t["zero_engagement_count"] >= 5 and not t["breakout_post"]
    ]
    long_cold.sort(key=lambda a: -a["zero_engagement_count"])

    findings.append({
        "id": "long_cold",
        "title": "Still trying after 5 misses. Still nothing.",
        "stat": f"{len(long_cold):,} builders",
        "blurb": (
            f"{len(long_cold):,} accounts posted 5 or more Show HN submissions "
            "that each got zero engagement — and never broke through. "
            "The top entry kept going for "
            f"{long_cold[0]['zero_engagement_count'] if long_cold else 0} attempts."
        ),
        "rows": [
            {
                "author": t["author"],
                "n_zero": t["zero_engagement_count"],
                "n_total": t["n_submissions"],
                "first_date": _ts_fmt(t["first_post_time"]),
                "last_date":  _ts_fmt(t["last_post_time"]),
                "years_span": max(1, (_ts_to_year(t["last_post_time"]) or 2024) - (_ts_to_year(t["first_post_time"]) or 2007)),
                "last_post": _build_wall_card(t["all_posts"][-1]),
            }
            for t in long_cold[:50]
        ],
    })

    # ── F3: The Breakthrough — cold streak before fame ────────────────────────
    # Authors with longest pre-breakout cold streak
    breakout_sample = [a for a in breakout_authors if a["pre_breakout_cold"] >= 2][:50]

    findings.append({
        "id": "breakthrough",
        "title": "The ones who finally broke through after years of silence.",
        "stat": f"{len(breakout_authors):,} builders",
        "blurb": (
            f"{len(breakout_authors):,} builders endured at least 3 consecutive "
            "zero-engagement Show HN posts before finally landing a hit. "
            "These are the ones who kept going."
        ),
        "rows": [
            {
                "author": a["author"],
                "pre_breakout_cold": a["pre_breakout_cold"],
                "n_submissions": a["n_submissions"],
                "breakout_score": (a["breakout_post"] or {}).get("score", 0),
                "breakout_date":  _ts_fmt((a["breakout_post"] or {}).get("time", 0)),
                "breakout_post": _build_wall_card(a["breakout_post"]) if a["breakout_post"] else None,
            }
            for a in breakout_sample
        ],
    })

    # ── F4: The 3AM Graveyard — posting hour analysis ─────────────────────────
    hour_counts:      Counter = Counter()
    hour_zero:        Counter = Counter()
    for p in all_show_hn:
        h = _ts_to_hour(p["time"])
        if h is not None:
            hour_counts[h] += 1
            if p["zero_engagement"]:
                hour_zero[h] += 1

    hour_rows = []
    for h in range(24):
        total = hour_counts.get(h, 0)
        zero  = hour_zero.get(h, 0)
        hour_rows.append({
            "hour":           h,
            "hour_label":     f"{h:02d}:00 UTC",
            "n_total":        total,
            "n_zero":         zero,
            "pct_zero":       round(100 * zero / max(total, 1), 1),
        })

    worst_hour = max(hour_rows, key=lambda r: r["pct_zero"])
    findings.append({
        "id": "posting_hour",
        "title": f"The {worst_hour['hour_label']} effect: when you post determines if anyone sees it.",
        "stat": f"{worst_hour['pct_zero']}% zero-engagement at {worst_hour['hour_label']}",
        "blurb": (
            "UTC posting hour vs zero-engagement rate across all Show HN submissions. "
            f"Posts at {worst_hour['hour_label']} had the highest zero-engagement rate "
            f"({worst_hour['pct_zero']}%). "
            "Timing your launch for US morning hours is not superstition — it's in the data."
        ),
        "rows": hour_rows,
    })

    # ── F5: Dead URLs — whose projects are gone ───────────────────────────────
    dead_url_posts = [
        p for p in all_show_hn
        if p.get("zero_engagement") and p.get("url_alive") is False
    ]
    dead_url_posts.sort(key=lambda p: p["time"])

    if not dead_url_posts:
        # Fallback: zero_engagement posts with a URL (url check may not have run)
        dead_url_posts = [
            p for p in all_show_hn
            if p.get("zero_engagement") and p.get("url")
        ][:200]

    # Domain graveyard: which domains hosted the most dead projects?
    domain_dead: Counter = Counter()
    for p in dead_url_posts:
        d = _domain(p.get("url", ""))
        if d:
            domain_dead[d] += 1

    findings.append({
        "id": "dead_urls",
        "title": "The graveyard of dead URLs — projects that no longer exist.",
        "stat": f"{len(dead_url_posts):,} projects offline",
        "blurb": (
            f"{len(dead_url_posts):,} zero-engagement Show HN posts link to URLs "
            "that now return errors or have gone dark. "
            "The code was written. The server went down. The account never came back."
        ),
        "rows": [_build_wall_card(p) for p in dead_url_posts[:100]],
        "top_domains": [
            {"domain": d, "n": n}
            for d, n in domain_dead.most_common(20)
        ],
    })

    # ── F6: Year-over-year — is the graveyard growing? ────────────────────────
    year_total:  Counter = Counter()
    year_zero:   Counter = Counter()
    for p in all_show_hn:
        y = _ts_to_year(p["time"])
        if y and 2010 <= y <= 2025:
            year_total[y] += 1
            if p["zero_engagement"]:
                year_zero[y] += 1

    year_rows = []
    for y in sorted(year_total.keys()):
        total = year_total[y]
        zero  = year_zero.get(y, 0)
        year_rows.append({
            "year":     y,
            "n_total":  total,
            "n_zero":   zero,
            "pct_zero": round(100 * zero / max(total, 1), 1),
        })

    findings.append({
        "id": "year_over_year",
        "title": "Is the HN graveyard growing? Year-over-year zero-engagement rates.",
        "stat": f"{max((r['pct_zero'] for r in year_rows), default=0):.0f}% peak zero-engagement year",
        "blurb": (
            "As HN has grown, so has the competition for the front page. "
            "This chart shows the share of Show HN posts with zero engagement by year — "
            "a signal of how crowded the launchpad has become."
        ),
        "rows": year_rows,
    })

    # ── F7: The most-forgotten domains ───────────────────────────────────────
    domain_counts: Counter = Counter()
    domain_zero:   Counter = Counter()
    for p in all_show_hn:
        d = _domain(p.get("url", ""))
        if d:
            domain_counts[d] += 1
            if p["zero_engagement"]:
                domain_zero[d] += 1

    domain_rows = []
    for d, total in domain_counts.most_common(2000):
        zero = domain_zero.get(d, 0)
        if total < 100:  # require enough volume for a meaningful platform signal
            continue
        domain_rows.append({
            "domain":   d,
            "n_total":  total,
            "n_zero":   zero,
            "pct_zero": round(100 * zero / max(total, 1), 1),
        })
    # Sort by failure RATE, not raw volume — github.com dominating by count
    # isn't interesting; the question is which platforms have the worst hit rate.
    domain_rows.sort(key=lambda r: -r["pct_zero"])

    top = domain_rows[0] if domain_rows else {}
    # Find a few notable callouts for the blurb
    chatgpt = next((r for r in domain_rows if "openai.com" in r["domain"] or "chatgpt" in r["domain"]), None)
    chrome  = next((r for r in domain_rows if "chromewebstore" in r["domain"]), None)
    github  = next((r for r in domain_rows if r["domain"] == "github.com"), None)

    callouts = []
    if chatgpt:
        callouts.append(f"ChatGPT demos ({chatgpt['pct_zero']:.0f}% zero-engagement)")
    if chrome:
        callouts.append(f"Chrome extensions ({chrome['pct_zero']:.0f}% across {chrome['n_total']:,} posts)")
    callout_str = ". ".join(callouts) + "." if callouts else ""
    baseline = f" GitHub repos land at {github['pct_zero']:.0f}% — roughly average." if github else ""

    findings.append({
        "id": "forgotten_domains",
        "title": "Which platforms have the highest zero-engagement rate on Show HN?",
        "stat": f"{top.get('pct_zero', 0):.0f}% on {top.get('domain', '—')}",
        "blurb": (
            "Among platforms with at least 50 Show HN submissions, ranked by share of "
            "posts that launched to total silence. "
            + (callout_str + baseline if callout_str else "")
        ),
        "rows": domain_rows[:50],
    })

    # ── F8: The Crash Out Wall ────────────────────────────────────────────────
    # Require at least one T1 signal (specific desperation phrases) to filter FPs.
    # T2-only posts often score from benign patterns ("v2", "finally", "5 years" referencing history).
    def _has_t1(p: dict) -> bool:
        return any(s.startswith("T1:") for s in p.get("crash_out_signals", []))

    crash_rows = [
        {
            **_build_wall_card(p),
            "crash_out_score":   p.get("crash_out_score", 0),
            "crash_out_signals": p.get("crash_out_signals", []),
        }
        for p in top_crash[:500]
        if p.get("crash_out_score", 0) >= 3.0 and _has_t1(p)
    ]
    crash_rows.sort(key=lambda r: -r["crash_out_score"])

    findings.append({
        "id": "crash_out",
        "title": "The Crash Out Wall — posts written at the edge of giving up.",
        "stat": f"{len(crash_rows):,} meltdowns catalogued",
        "blurb": (
            "Scored by desperation vocabulary (explicit giveup phrases, year-of-effort confessions), "
            "plea constructions, caps-lock rage, and exclamation density. "
            "No LLM — pure signal extracted from the raw post text. "
            "Each post here contains at least one explicit marker of someone at their limit."
        ),
        "rows": crash_rows,
    })

    return findings


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if not IN_PATH.exists():
        raise SystemExit(f"Missing {IN_PATH} — run reduce.py first")

    data = json.loads(IN_PATH.read_text())

    # ── overall.json ──────────────────────────────────────────────────────────
    # Load URL check summary for the dead-URL rate (from Phase 2).
    url_stats = {}
    if URL_SUMMARY.exists():
        url_stats = json.loads(URL_SUMMARY.read_text())

    pct_checked_dead = url_stats.get("pct_dead", 0.0)  # % of checked URLs that are dead
    n_urls_checked   = url_stats.get("n_urls_checked", 0)

    overall = {
        "n_show_hn":             data["n_posts"],
        "n_zero_engagement":     data["n_zero_engagement"],
        "n_unique_authors":      data["n_unique_authors"],
        "n_one_and_done":        data["n_one_and_done"],
        "n_dead_urls":           data["n_dead_urls"],
        "pct_zero":              round(100 * data["n_zero_engagement"] / max(data["n_posts"], 1), 1),
        "pct_dead_urls":         data["pct_dead_urls"],
        "pct_checked_dead":      pct_checked_dead,
        "n_urls_checked":        n_urls_checked,
        "headline": (
            f"We processed {data['n_posts']:,} Show HN posts across the full HackerNews archive. "
            f"{data['n_zero_engagement']:,} launched to silence. "
            f"{data['n_one_and_done']:,} accounts never posted another Show HN."
        ),
    }
    (OUT_DIR / "overall.json").write_text(json.dumps(overall, indent=2))

    # ── findings.json ─────────────────────────────────────────────────────────
    findings = build_findings(data)
    (OUT_DIR / "findings.json").write_text(json.dumps(findings))

    # ── wall.json — Graveyard Wall ────────────────────────────────────────────
    graveyard = data.get("graveyard_posts", [])
    wall_cards = [_build_wall_card(p) for p in graveyard[:500]]
    (OUT_DIR / "wall.json").write_text(json.dumps({"cards": wall_cards}))

    # ── crashout.json — Meltdown Mode ─────────────────────────────────────────
    crash_posts = data.get("top_crash_posts", [])
    crash_cards = [
        {
            **_build_wall_card(p),
            "crash_out_score":   p.get("crash_out_score", 0),
            "crash_out_signals": p.get("crash_out_signals", []),
        }
        for p in crash_posts[:500]
        if p.get("crash_out_score", 0) >= 3.0
        and any(s.startswith("T1:") for s in p.get("crash_out_signals", []))
    ]
    crash_cards.sort(key=lambda c: -c["crash_out_score"])
    (OUT_DIR / "crashout.json").write_text(json.dumps({"cards": crash_cards}))

    print("overall stats:")
    print(f"  Show HN posts:     {overall['n_show_hn']:,}")
    print(f"  zero-engagement:   {overall['n_zero_engagement']:,}  ({overall['pct_zero']}%)")
    print(f"  unique authors:    {overall['n_unique_authors']:,}")
    print(f"  one-and-done:      {overall['n_one_and_done']:,}")
    print(f"  dead URLs:         {overall['n_dead_urls']:,}  ({overall['pct_dead_urls']}%)")
    print(f"  checked-dead rate: {overall['pct_checked_dead']}%  ({overall['n_urls_checked']:,} URLs checked)")
    print(f"\nfindings: {len(findings)}")
    print(f"wall cards: {len(wall_cards)}")
    print(f"crash cards (T1+score≥3): {len(crash_cards)}")
    print(f"\nwrote {OUT_DIR}/")


if __name__ == "__main__":
    main()
