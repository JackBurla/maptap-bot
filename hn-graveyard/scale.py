"""
Phase 1: Fan out Show HN extraction to 1,000 Burla workers.

Calls the HuggingFace datasets-server API to get all parquet file URLs
for the open-index/hacker-news dataset, then dispatches each file to a
Burla worker via remote_parallel_map.

Each worker (pipeline.process_file) downloads one monthly parquet file,
extracts Show HN: posts, scores them, and writes results to
/workspace/shared/hn/shards/{shard_id}.json.

Usage:
    python scale.py [--limit N]
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import requests
from burla import remote_parallel_map

from pipeline import process_file

HF_REPO_API = "https://huggingface.co/api/datasets/open-index/hacker-news/tree/main/data"
HF_BASE_URL = "https://huggingface.co/datasets/open-index/hacker-news/resolve/main"

HERE = Path(__file__).parent
SUMMARY_PATH = HERE / "samples" / "scale_summary.json"


def fetch_file_listing() -> list[str]:
    """Walk the HuggingFace repo tree and return sorted list of parquet file URLs."""
    print("fetching parquet file listing from HuggingFace repo tree ...")
    r = requests.get(HF_REPO_API, timeout=30)
    r.raise_for_status()
    year_dirs = [entry["path"] for entry in r.json()]

    urls = []
    for year_dir in sorted(year_dirs):
        r2 = requests.get(
            f"https://huggingface.co/api/datasets/open-index/hacker-news/tree/main/{year_dir}",
            timeout=30,
        )
        if not r2.ok:
            continue
        for entry in r2.json():
            path = entry.get("path", "")
            if path.endswith(".parquet"):
                urls.append(f"{HF_BASE_URL}/{path}")

    urls = sorted(urls)
    print(f"  found {len(urls)} parquet files")
    return urls


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="debug: process only first N files")
    ap.add_argument("--max-parallelism", type=int, default=1000)
    args = ap.parse_args()

    SUMMARY_PATH.parent.mkdir(parents=True, exist_ok=True)

    urls = fetch_file_listing()
    if args.limit:
        urls = urls[: args.limit]
        print(f"  (limited to {args.limit} files for debug)")

    # Build job tuples: (file_url, shard_id)
    jobs = [(url, f"shard_{i:05d}") for i, url in enumerate(urls)]
    print(f"\n{len(jobs):,} files to process — fanning out to Burla workers ...")

    t0 = time.time()
    results = remote_parallel_map(
        process_file,
        jobs,
        func_cpu=1,
        func_ram=4,
        grow=True,
        max_parallelism=args.max_parallelism,
        spinner=True,
    )
    elapsed = time.time() - t0

    successes = [r for r in results if "error" not in r]
    failures  = [r for r in results if "error" in r]

    total_rows      = sum(r.get("n_total_rows", 0) for r in successes)
    total_show_hn   = sum(r.get("n_show_hn", 0) for r in successes)
    total_zero      = sum(r.get("n_zero_engagement", 0) for r in successes)

    summary = {
        "elapsed_seconds":       round(elapsed, 2),
        "elapsed_minutes":       round(elapsed / 60, 2),
        "n_files":               len(jobs),
        "n_succeeded":           len(successes),
        "n_failed":              len(failures),
        "total_hn_rows":         total_rows,
        "total_show_hn":         total_show_hn,
        "total_zero_engagement": total_zero,
        "throughput_files_per_sec": round(len(successes) / max(elapsed, 1), 2),
        "first_failures": failures[:5],
    }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2))

    print(f"\n{'=' * 70}")
    print(f"elapsed:      {summary['elapsed_minutes']} min")
    print(f"files:        {len(successes):,} succeeded / {len(failures):,} failed")
    print(f"HN rows:      {total_rows:,}")
    print(f"Show HN:      {total_show_hn:,}")
    print(f"zero-engage:  {total_zero:,}  ({100 * total_zero / max(total_show_hn, 1):.1f}% of Show HN)")
    print(f"wrote {SUMMARY_PATH}")

    if failures:
        print(f"\nfirst failure: {failures[0]}")

    print("\nnext: python url_scale.py  →  python reduce.py  →  python analysis.py")


if __name__ == "__main__":
    main()
