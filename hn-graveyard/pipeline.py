"""
Core worker function for the HN Graveyard pipeline.

Each Burla worker receives a (file_url, shard_id) tuple. It:
  1. Downloads the monthly parquet file from HuggingFace
  2. Filters for Show HN: posts
  3. For each Show HN post, computes:
       - zero_engagement  (score == 1, no comments, not deleted/dead)
       - dead_on_arrival  (dead == True, score <= 1)
       - crash_out_score  (rule-based desperation signal, no LLM)
  4. Writes shard JSON to /workspace/shared/hn/shards/{shard_id}.json

crash_out_score signals (each contributes 0–N points):
  - Desperation vocabulary hits in title + text (weighted)
  - Text length > 600 words (+2)
  - Self-reference to prior post (v2, repost, posted before, last year) (+2 each)
  - ALL CAPS word ratio in text (scaled 0–3)
  - Exclamation mark density in text (scaled 0–2)
  - Multi-year effort references (years of work, spent X years) (+3)
  - Plea constructions (please, someone, anyone, help me) (+1 each hit)

Output shard schema:
  {
    "shard_id": str,
    "file_url": str,
    "n_total_rows": int,
    "n_show_hn": int,
    "n_zero_engagement": int,
    "posts": [
      {
        "id": int,
        "by": str,
        "time": int,
        "title": str,
        "text": str,        # first 1200 chars of HTML-stripped text
        "url": str,
        "score": int,
        "descendants": int,
        "dead": bool,
        "deleted": bool,
        "zero_engagement": bool,
        "dead_on_arrival": bool,
        "crash_out_score": float,
        "crash_out_signals": list[str],
      },
      ...
    ]
  }
"""
from __future__ import annotations

import io
import json
import math
import os
import re
import time
from typing import Any

OUTPUT_DIR = "/workspace/shared/hn/shards"

# ── crash_out vocabulary ──────────────────────────────────────────────────────

_DESPERATION_TIER1 = [
    # high weight — explicit despair
    r"years of my life",
    r"gave up",
    r"i give up",
    r"nobody cares",
    r"no one cares",
    r"last time",
    r"i know this won.t",
    r"i know nobody",
    r"not going to make it",
    r"this is it",
    r"i.m done",
    r"why doesn.t anyone",
    r"why does nobody",
    r"ignored again",
    r"buried again",
    r"wasted years",
    r"spent \d+ years",
    r"built this for \d+",
    r"one more try",
    r"final attempt",
    r"last attempt",
    r"last shot",
]

_DESPERATION_TIER2 = [
    # medium weight
    r"please",
    r"nobody",
    r"no one",
    r"ignored",
    r"again$",
    r"again\b.*time",
    r"not getting traction",
    r"never gets seen",
    r"trying again",
    r"reposting",
    r"repost",
    r"posted before",
    r"posted this before",
    r"launching again",
    r"second attempt",
    r"third attempt",
    r"v2",
    r"v3",
    r"3 years",
    r"4 years",
    r"5 years",
    r"does anyone",
    r"anyone interested",
    r"is anyone",
]

_DESPERATION_TIER3 = [
    # light weight
    r"finally",
    r"someone",
    r"help me",
    r"help us",
    r"last year",
    r"years ago",
    r"long time",
    r"hard work",
    r"a lot of work",
    r"so much work",
    r"embarrassing",
    r"been working",
]


def _strip_html(text: str) -> str:
    """Remove HTML tags and decode common entities."""
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    text = text.replace("&quot;", '"').replace("&#x27;", "'").replace("&apos;", "'")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def compute_crash_out_score(title: str, raw_text: str) -> tuple[float, list[str]]:
    """
    Rule-based crash-out desperation score. No LLM.
    Returns (score, signals_hit).
    """
    text = _strip_html(raw_text or "")
    combined = (title.lower() + " " + text.lower())
    signals: list[str] = []
    score = 0.0

    # Tier 1 — high weight hits (3 pts each)
    for pattern in _DESPERATION_TIER1:
        if re.search(pattern, combined):
            score += 3.0
            tag = pattern.replace(r"\b", "").replace(r"\\d+", "N").replace(r"\.", "").replace(r"\s+", " ").strip()
            signals.append(f"T1:{tag[:40]}")

    # Tier 2 — medium weight (1.5 pts each)
    for pattern in _DESPERATION_TIER2:
        if re.search(pattern, combined):
            score += 1.5
            tag = pattern.replace(r"\b", "").replace(r"$", "").strip()
            signals.append(f"T2:{tag[:30]}")

    # Tier 3 — light weight (0.75 pts each)
    for pattern in _DESPERATION_TIER3:
        if re.search(pattern, combined):
            score += 0.75
            signals.append(f"T3:{pattern[:25]}")

    # Text length signal — long posts smell like manifestos
    words = text.split()
    if len(words) > 600:
        score += 2.0
        signals.append(f"len:{len(words)}w")

    # ALL CAPS ratio in text (excluding URLs and common abbreviations)
    if words:
        caps_words = [w for w in words if len(w) >= 3 and w.isupper() and not w.startswith("HTTP")]
        caps_ratio = len(caps_words) / len(words)
        if caps_ratio > 0.05:
            pts = min(3.0, caps_ratio * 20)
            score += pts
            signals.append(f"caps:{caps_ratio:.0%}")

    # Exclamation mark density
    exclaim_count = text.count("!")
    if exclaim_count > 0 and len(words) > 0:
        exclaim_density = exclaim_count / max(len(words), 1)
        if exclaim_density > 0.02:
            pts = min(2.0, exclaim_density * 30)
            score += pts
            signals.append(f"exclaim:{exclaim_count}")

    # Question bombardment — multiple desperate questions
    question_count = combined.count("?")
    if question_count >= 4:
        score += 1.5
        signals.append(f"questions:{question_count}")

    return round(score, 2), signals[:12]


# ── worker ────────────────────────────────────────────────────────────────────

def process_file(file_url: str, shard_id: str) -> dict[str, Any]:
    """
    Runs on a Burla worker. Downloads one monthly parquet file and extracts
    all Show HN: posts with engagement metrics and crash-out scoring.
    """
    import io, json, os, requests, subprocess, time

    # Install pyarrow on the remote worker if not present
    try:
        import pyarrow.parquet as pq
    except ModuleNotFoundError:
        subprocess.run(["pip", "install", "pyarrow", "-q"], capture_output=True, check=True)
        import pyarrow.parquet as pq

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    t0 = time.time()
    try:
        r = requests.get(file_url, timeout=180)
        r.raise_for_status()
    except Exception as e:
        return {"shard_id": shard_id, "file_url": file_url, "error": str(e), "n_show_hn": 0}

    download_sec = time.time() - t0

    try:
        buf = io.BytesIO(r.content)
        table = pq.read_table(buf)
    except Exception as e:
        return {"shard_id": shard_id, "file_url": file_url, "error": f"parquet: {e}", "n_show_hn": 0}

    df = table.to_pydict()
    n_total = len(df.get("id") or [])

    posts = []
    n_zero = 0

    for i in range(n_total):
        title = (df.get("title") or [""])[i] or ""
        if not title.upper().startswith("SHOW HN"):
            continue

        item_id   = (df.get("id") or [None])[i]
        by        = (df.get("by") or [""])[i] or ""
        raw_time  = (df.get("time") or [0])[i] or 0
        ts        = int(raw_time.timestamp()) if hasattr(raw_time, "timestamp") else int(raw_time or 0)
        raw_text  = (df.get("text") or [""])[i] or ""
        url       = (df.get("url") or [""])[i] or ""
        score     = int((df.get("score") or [0])[i] or 0)
        desc      = int((df.get("descendants") or [0])[i] or 0)
        dead      = bool((df.get("dead") or [False])[i])
        deleted   = bool((df.get("deleted") or [False])[i])

        if deleted:
            continue

        zero_engagement  = (score <= 1 and desc == 0 and not dead)
        dead_on_arrival  = (dead and score <= 1)

        stripped_text = _strip_html(raw_text)
        text_excerpt  = stripped_text[:1200]

        crash_score, crash_signals = compute_crash_out_score(title, raw_text)

        if zero_engagement:
            n_zero += 1

        posts.append({
            "id":               item_id,
            "by":               by,
            "time":             ts,
            "title":            title,
            "text":             text_excerpt,
            "url":              url,
            "score":            score,
            "descendants":      desc,
            "dead":             dead,
            "deleted":          deleted,
            "zero_engagement":  zero_engagement,
            "dead_on_arrival":  dead_on_arrival,
            "crash_out_score":  crash_score,
            "crash_out_signals": crash_signals,
        })

    payload = {
        "shard_id":          shard_id,
        "file_url":          file_url,
        "n_total_rows":      n_total,
        "n_show_hn":         len(posts),
        "n_zero_engagement": n_zero,
        "download_sec":      round(download_sec, 2),
        "posts":             posts,
    }

    out_path = os.path.join(OUTPUT_DIR, f"{shard_id}.json")
    with open(out_path, "w") as f:
        json.dump(payload, f)

    return {
        "shard_id":          shard_id,
        "n_total_rows":      n_total,
        "n_show_hn":         len(posts),
        "n_zero_engagement": n_zero,
    }
