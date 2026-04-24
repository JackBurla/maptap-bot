"""
Phase 3: Merge all shard outputs into the full dataset.

Reads /workspace/shared/hn/shards/*.json  (from scale.py)
Reads /workspace/shared/hn/url_shards/*.json  (from url_scale.py, optional)

Builds:
  - Per-author Show HN trajectory (n_submissions, max_score, cold_streak,
    ever_returned, breakout_post, last_post_time)
  - Global stats
  - Top crash-out posts

Writes: samples/reduced.json

Run this locally after scale.py (and optionally url_scale.py) completes.
You may also run it on the Burla cluster by importing and calling from a script.

Usage:
    python reduce.py
"""
from __future__ import annotations

import argparse
import json
import os
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

SHARD_DIR     = "/workspace/shared/hn/shards"
URL_SHARD_DIR = "/workspace/shared/hn/url_shards"
REDUCED_PATH  = "/workspace/shared/hn/reduced.json"

HERE = Path(__file__).parent
OUT_PATH = HERE / "samples" / "reduced.json"


# ── cluster-side reduce job ───────────────────────────────────────────────────

def run_reduce_on_cluster(_: int) -> dict:
    """
    Runs on a single Burla worker with access to /workspace/shared.
    Reads all shard files, builds author trajectories, writes reduced.json
    to shared disk. Returns a summary dict.
    """
    import json, os, time
    from collections import defaultdict

    shard_dir     = "/workspace/shared/hn/shards"
    url_shard_dir = "/workspace/shared/hn/url_shards"
    out_path      = "/workspace/shared/hn/reduced.json"

    t0 = time.time()

    # ── load all posts ────────────────────────────────────────────────────────
    posts = []
    for fname in sorted(os.listdir(shard_dir)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(shard_dir, fname)) as f:
                shard = json.load(f)
            posts.extend(shard.get("posts", []))
        except Exception:
            pass

    # ── load URL results ──────────────────────────────────────────────────────
    url_results = {}
    if os.path.exists(url_shard_dir):
        for fname in os.listdir(url_shard_dir):
            if not fname.endswith(".json"):
                continue
            try:
                with open(os.path.join(url_shard_dir, fname)) as f:
                    shard = json.load(f)
                for r in shard.get("results", []):
                    url = r.get("url", "")
                    if url:
                        url_results[url] = r
            except Exception:
                pass

    # Attach URL aliveness to posts
    for post in posts:
        url = post.get("url", "")
        if url and url in url_results:
            post["url_alive"]  = url_results[url].get("alive")
            post["url_status"] = url_results[url].get("status")
            post["url_error"]  = url_results[url].get("error")
        else:
            post["url_alive"]  = None
            post["url_status"] = None
            post["url_error"]  = None

    # ── build author trajectories ─────────────────────────────────────────────
    by_author = defaultdict(list)
    for post in posts:
        by_author[post["by"]].append(post)

    trajectories = {}
    for author, aposts in by_author.items():
        if not author:
            continue
        aposts.sort(key=lambda p: p["time"])
        n         = len(aposts)
        max_score = max(p["score"] for p in aposts)
        zero_cnt  = sum(1 for p in aposts if p["zero_engagement"])

        cold_streak = 0
        current_streak = 0
        for p in aposts:
            if p["zero_engagement"]:
                current_streak += 1
                cold_streak = max(cold_streak, current_streak)
            else:
                current_streak = 0

        breakout = None
        for p in aposts:
            if p["score"] >= 10:
                breakout = p
                break

        pre_breakout_cold = 0
        if breakout:
            for p in aposts:
                if p["id"] == breakout["id"]:
                    break
                if p["zero_engagement"]:
                    pre_breakout_cold += 1

        trajectories[author] = {
            "author":             author,
            "n_submissions":      n,
            "max_score":          max_score,
            "zero_engagement_count": zero_cnt,
            "cold_streak":        cold_streak,
            "pre_breakout_cold":  pre_breakout_cold,
            "ever_returned":      n > 1,
            "one_and_done":       (n == 1 and zero_cnt == 1),
            "first_post_time":    aposts[0]["time"],
            "last_post_time":     aposts[-1]["time"],
            "breakout_post":      breakout,
            "all_posts":          aposts,
        }

    # ── aggregate stats ───────────────────────────────────────────────────────
    n_posts         = len(posts)
    n_zero          = sum(1 for p in posts if p["zero_engagement"])
    n_with_url      = sum(1 for p in posts if p.get("url"))
    n_dead_urls     = sum(1 for p in posts if p.get("url_alive") is False)
    n_alive_urls    = sum(1 for p in posts if p.get("url_alive") is True)
    n_one_and_done  = sum(1 for a in trajectories.values() if a["one_and_done"])
    n_never_returned = sum(1 for a in trajectories.values() if not a["ever_returned"] and a["zero_engagement_count"] > 0)

    crash_posts = [p for p in posts if p["zero_engagement"] and p.get("crash_out_score", 0) > 0]
    crash_posts.sort(key=lambda p: -p["crash_out_score"])

    breakout_authors = sorted(
        [a for a in trajectories.values() if a["breakout_post"] and a["pre_breakout_cold"] >= 3],
        key=lambda a: -a["pre_breakout_cold"]
    )

    never_returned_set = {a for a, t in trajectories.items() if not t["ever_returned"]}
    graveyard_posts = [p for p in posts if p["zero_engagement"] and p["by"] in never_returned_set]
    graveyard_posts.sort(key=lambda p: -(p.get("crash_out_score", 0) * 0.3 + (1 if p.get("url") else 0)))

    payload = {
        "generated_at":      int(time.time()),
        "n_posts":           n_posts,
        "n_zero_engagement": n_zero,
        "n_unique_authors":  len(trajectories),
        "n_one_and_done":    n_one_and_done,
        "n_never_returned":  n_never_returned,
        "n_with_url":        n_with_url,
        "n_dead_urls":       n_dead_urls,
        "n_alive_urls":      n_alive_urls,
        "pct_dead_urls":     round(100 * n_dead_urls / max(n_with_url, 1), 1),
        "trajectories":      trajectories,
        "top_crash_posts":   crash_posts[:500],
        "breakout_authors":  breakout_authors[:200],
        "graveyard_posts":   graveyard_posts[:2000],
    }

    with open(out_path, "w") as f:
        json.dump(payload, f)

    return {
        "n_posts":           n_posts,
        "n_zero_engagement": n_zero,
        "n_unique_authors":  len(trajectories),
        "n_one_and_done":    n_one_and_done,
        "n_never_returned":  n_never_returned,
        "n_dead_urls":       n_dead_urls,
        "pct_dead_urls":     round(100 * n_dead_urls / max(n_with_url, 1), 1),
        "elapsed_sec":       round(time.time() - t0, 1),
        "out_path":          out_path,
    }


def download_reduced(_: int) -> str:
    """Read reduced.json from shared disk and return it as a string."""
    import json
    with open("/workspace/shared/hn/reduced.json") as f:
        return f.read()


# ── (unused locally) legacy shard readers kept for reference ─────────────────

def read_all_posts(shard_dir: str) -> list[dict]:
    posts = []
    if not os.path.exists(shard_dir):
        raise SystemExit(f"Shard dir not found: {shard_dir} — run scale.py first")
    for fname in sorted(f for f in os.listdir(shard_dir) if f.endswith(".json")):
        try:
            with open(os.path.join(shard_dir, fname)) as f:
                shard = json.load(f)
            posts.extend(shard.get("posts", []))
        except Exception:
            pass
    return posts


def read_url_results(url_shard_dir: str) -> dict[str, dict]:
    results: dict[str, dict] = {}
    if not os.path.exists(url_shard_dir):
        return results
    for fname in (f for f in os.listdir(url_shard_dir) if f.endswith(".json")):
        try:
            with open(os.path.join(url_shard_dir, fname)) as f:
                shard = json.load(f)
            for r in shard.get("results", []):
                url = r.get("url", "")
                if url:
                    results[url] = r
        except Exception:
            pass
    return results


# ── author trajectory builder ─────────────────────────────────────────────────

def build_author_trajectories(posts: list[dict]) -> dict[str, dict]:
    """
    For each author, build their Show HN trajectory:
      - all_posts: list sorted by time
      - n_submissions: total Show HN posts
      - max_score: peak score
      - breakout_post: first post to score >= 10 (if any)
      - zero_engagement_count: posts with score <= 1 and no comments
      - cold_streak: longest consecutive zero-engagement run
      - ever_returned: posted again after first submission
      - first_post_time / last_post_time
      - one_and_done: exactly 1 post, zero engagement
    """
    by_author: dict[str, list[dict]] = defaultdict(list)
    for post in posts:
        by_author[post["by"]].append(post)

    trajectories: dict[str, dict] = {}

    for author, author_posts in by_author.items():
        if not author:
            continue

        # Sort by time ascending
        author_posts.sort(key=lambda p: p["time"])

        n = len(author_posts)
        max_score = max(p["score"] for p in author_posts)
        zero_count = sum(1 for p in author_posts if p["zero_engagement"])

        # Longest consecutive zero-engagement streak
        cold_streak = 0
        current_streak = 0
        for p in author_posts:
            if p["zero_engagement"]:
                current_streak += 1
                cold_streak = max(cold_streak, current_streak)
            else:
                current_streak = 0

        # Breakout post: first to score >= 10
        breakout = None
        for p in author_posts:
            if p["score"] >= 10:
                breakout = p
                break

        # Pre-breakout cold streak: consecutive zero-engagement posts before breakout
        pre_breakout_cold = 0
        if breakout:
            for p in author_posts:
                if p["id"] == breakout["id"]:
                    break
                if p["zero_engagement"]:
                    pre_breakout_cold += 1

        trajectories[author] = {
            "author":             author,
            "n_submissions":      n,
            "max_score":          max_score,
            "zero_engagement_count": zero_count,
            "cold_streak":        cold_streak,
            "pre_breakout_cold":  pre_breakout_cold,
            "ever_returned":      n > 1,
            "one_and_done":       (n == 1 and zero_count == 1),
            "first_post_time":    author_posts[0]["time"],
            "last_post_time":     author_posts[-1]["time"],
            "breakout_post":      breakout,
            "all_posts":          author_posts,
        }

    return trajectories


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    from burla import remote_parallel_map

    ap = argparse.ArgumentParser()
    ap.parse_args()

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Run reduction on cluster — returns summary; full data written to shared disk
    print("running reduction on Burla cluster ...")
    summaries = remote_parallel_map(
        run_reduce_on_cluster,
        [0],
        func_cpu=1,
        func_ram=8,
        grow=True,
        spinner=True,
    )
    summary = summaries[0]
    print(f"\ncluster reduction complete in {summary['elapsed_sec']}s:")
    print(f"  Show HN posts:   {summary['n_posts']:,}")
    print(f"  zero-engagement: {summary['n_zero_engagement']:,}  ({100 * summary['n_zero_engagement'] / max(summary['n_posts'], 1):.1f}%)")
    print(f"  unique authors:  {summary['n_unique_authors']:,}")
    print(f"  one-and-done:    {summary['n_one_and_done']:,}")
    print(f"  never returned:  {summary['n_never_returned']:,}")
    print(f"  dead URLs:       {summary['n_dead_urls']:,}  ({summary['pct_dead_urls']}%)")

    # Download reduced.json from cluster shared disk
    print("\ndownloading reduced.json from cluster ...")
    raw_list = remote_parallel_map(
        download_reduced,
        [0],
        func_cpu=1,
        func_ram=8,
        grow=True,
        spinner=True,
    )
    OUT_PATH.write_text(raw_list[0])
    size_mb = OUT_PATH.stat().st_size / 1024 / 1024
    print(f"wrote {OUT_PATH}  ({size_mb:.1f} MB)")
    print("\nnext: python analysis.py")


if __name__ == "__main__":
    main()
