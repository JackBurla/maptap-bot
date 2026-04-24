# The HN Graveyard

> We processed the entire HackerNews archive — every Show HN ever posted.  
> Hundreds of thousands got zero engagement.  
> Most of those accounts were never heard from again.  
> We found them all.

**Live demo:** https://burla-cloud.github.io/hn-graveyard/

---

## Numbers at a Glance

| Metric | Value |
|--------|-------|
| Show HN posts processed | ~412,000 |
| Zero-engagement posts | ~178,000 (43.2%) |
| Unique authors | ~202,000 |
| One-and-done builders | ~89,000 |
| Accounts that never returned | ~74,000 |
| Dead project URLs | ~31,000 (62.4% of checked) |
| Dataset size | 11.6 GB (230 monthly Parquet files) |
| Workers used | 1,000 parallel Burla workers |
| Phase 1 runtime | ~4 minutes |
| Phase 2 runtime (URL checks) | ~8 minutes |

---

## What This Is

HackerNews has a `Show HN:` convention where builders share projects they've made.
These posts compete for front-page placement against 400+ submissions per day.

Most never make it. Many get exactly one point — the auto-upvote from submission —
and zero comments. The builder waits. Nothing happens. In thousands of cases,
that account was never used again.

This analysis finds those posts. It also finds the desperate ones — posts from people
who'd tried multiple times, who referenced their years of effort in the text,
who clearly cracked a little under the weight of being ignored.

And it finds the rare few who kept going and eventually broke through.

---

## Findings

1. **One-and-Done** — 89K builders posted once, got nothing, were never heard from again
2. **The Long Cold** — 3K accounts posted 5+ zero-engagement Show HNs without ever breaking through
3. **The Breakthrough** — 1.8K accounts endured 3+ consecutive misses before finally landing a hit
4. **The 3AM Effect** — posts at 02:00 UTC have a 67% zero-engagement rate vs 31% at peak hours
5. **Dead URLs** — 31K project links are now offline; Heroku and Glitch lead the graveyard
6. **Year-over-Year** — zero-engagement rate climbed from 20% in 2010 to 53% in 2024
7. **Forgotten Domains** — platforms with highest zero-engagement rates by host
8. **The Crash Out Wall** (Meltdown Mode) — the most desperate posts, scored by rule-based signals

---

## Reproduce

### Prerequisites

```bash
pip install burla>=0.3.0 requests>=2.31.0 pyarrow>=14.0.0
```

Requires a [Burla](https://burla.dev) account with cluster access.

### Steps

```bash
# 1. Verify HuggingFace dataset access and schema
python probe.py

# 2. Phase 1: Extract all Show HN posts (1,000 workers, ~4 min)
python scale.py

# 3. Phase 2: Check URL aliveness (1,000 workers, ~8 min)
python url_scale.py

# 4. Merge + reduce on the cluster output
python reduce.py

# 5. Generate UI-ready JSON artifacts
python analysis.py

# 6. Open index.html locally or serve with:
python -m http.server 8000
```

To test with a small subset:
```bash
python scale.py --limit 10       # process only 10 monthly files
python url_scale.py --limit 1000 # check only 1,000 URLs
```

---

## Pipeline Architecture

```
HuggingFace open-index/hacker-news (11.6 GB, 230 Parquet files)
         │
         │  scale.py  ─────────────────────────────────────────────
         ▼                                                          │
  [1,000 Burla workers]                                            │
  pipeline.process_file(file_url, shard_id)                       │
    • Download monthly Parquet                                      │
    • Filter Show HN: posts                                         │
    • Score: zero_engagement, dead_on_arrival, crash_out_score     │
    • Write → /workspace/shared/hn/shards/{shard_id}.json          │
         │                                                          │
         │  url_scale.py  ─────────────────────────────────────────
         ▼
  [1,000 Burla workers]
  url_check.check_batch([(post_id, url), ...], shard_id)
    • HTTP GET with 15s timeout + browser UA
    • Record: alive, status_code, redirected_to, error
    • Write → /workspace/shared/hn/url_shards/{shard_id}.json
         │
         │  reduce.py
         ▼
  Per-author Show HN trajectories
  (cold_streak, breakout_post, one_and_done, ...)
    • Write → samples/reduced.json
         │
         │  analysis.py
         ▼
  data/overall.json   — hero stats
  data/wall.json      — Graveyard Wall cards
  data/crashout.json  — Meltdown Mode cards
  data/findings.json  — 8 annotated findings
```

---

## Definitions

**Zero engagement**: `score == 1` AND `descendants == 0` AND not `dead` AND not `deleted`.
This is the strictest possible definition — only the auto-upvote from submission, no comments.

**Dead on arrival**: marked `dead == True` by HN moderators with `score <= 1`.

**Never returned**: author has exactly one post in the entire HN dataset
(not just Show HN — their account shows no subsequent activity).

**Crash-out score**: a rule-based desperation signal computed from post title and text.
No LLM. Inputs:
- **T1 signals** (3 pts each): explicit despair phrases — "years of my life", "i give up",
  "nobody cares", "last time", "i know this won't", "why doesn't anyone", etc.
- **T2 signals** (1.5 pts each): medium-weight phrases — "please", "nobody", "repost",
  "posted before", "4 years", "third attempt", "ignored", etc.
- **T3 signals** (0.75 pts each): softer signals — "finally", "someone", "long time", etc.
- **Text length** > 600 words: +2 pts
- **ALL CAPS ratio** > 5%: scaled 0–3 pts
- **Exclamation density** > 2%: scaled 0–2 pts
- **≥4 question marks**: +1.5 pts

---

## Caveats

- **Dataset coverage**: the `open-index/hacker-news` HuggingFace dataset is a mirror
  of the official Firebase HN API. It is comprehensive but may lag by days to weeks
  for the most recent months.
- **"Never returned" accuracy**: we only see HN activity. A builder may have moved to
  a different platform or changed username.
- **URL aliveness**: a 200 response doesn't prove the original project still exists —
  a domain may have been repurchased. A 404 doesn't always mean the project is dead —
  some repos are private or reorganized.
- **Crash-out score**: the rule-based scoring is intentionally aggressive. High scores
  indicate *signals of desperation* in the text, not a clinical assessment of the author's
  mental state. Many high-scoring posts are simply enthusiastic rather than despairing.
- **Show HN filtering**: we match `title.upper().startswith("SHOW HN")` which captures
  common variants ("Show HN:", "Show HN -", "Show HN –", etc).

---

## Built With

- [Burla](https://burla.dev) — parallel compute on 1,000 CPUs
- [open-index/hacker-news](https://huggingface.co/datasets/open-index/hacker-news) — HuggingFace dataset
- [PyArrow](https://arrow.apache.org/docs/python/) — Parquet parsing
- Vanilla HTML/CSS/JS — no frameworks

---

*Part of the [Burla demo series](https://burla.dev/demos). See also:*
*[Amazon Review Distiller](https://burla-cloud.github.io/amazon-review-distiller/)*
