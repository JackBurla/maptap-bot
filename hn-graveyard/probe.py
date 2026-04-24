"""
Smoke-test: verify the open-index/hacker-news HuggingFace dataset is
accessible, discover the parquet file listing, and validate the schema
on a single monthly file before running the full pipeline.

Usage:
    python probe.py
"""
from __future__ import annotations

import io
import json
import sys
import time

import requests

HF_REPO_API  = "https://huggingface.co/api/datasets/open-index/hacker-news/tree/main/data"
HF_BASE_URL  = "https://huggingface.co/datasets/open-index/hacker-news/resolve/main"
EXPECTED_COLUMNS = {"id", "type", "by", "time", "title", "text", "url", "score", "descendants", "dead", "deleted"}


def fetch_parquet_listing() -> list[dict]:
    """
    Walk the HuggingFace repo tree to discover all monthly parquet files.
    Returns list of dicts with keys: url, path, size.
    """
    print("1. fetching parquet file listing from HuggingFace repo tree ...")
    t0 = time.time()

    # List year-level directories
    r = requests.get(HF_REPO_API, timeout=30)
    r.raise_for_status()
    year_dirs = [entry["path"] for entry in r.json() if entry.get("type") == "directory" or entry.get("size") == 0]

    files = []
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
                files.append({
                    "url":  f"{HF_BASE_URL}/{path}",
                    "path": path,
                    "size": entry.get("size", 0),
                })

    print(f"   OK ({time.time() - t0:.2f}s) — found {len(files)} parquet files")
    return files


def probe_one_file(url: str) -> None:
    """Download a single parquet file and validate schema + sample rows."""
    import pyarrow.parquet as pq

    print(f"\n2. probing file: {url.split('/')[-1]} ...")
    t0 = time.time()
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    size_mb = len(r.content) / 1024 / 1024
    print(f"   downloaded {size_mb:.1f} MB in {time.time() - t0:.2f}s")

    buf = io.BytesIO(r.content)
    table = pq.read_table(buf)
    cols = set(table.schema.names)
    n_rows = len(table)
    print(f"   rows:    {n_rows:,}")
    print(f"   columns: {sorted(cols)}")

    missing = EXPECTED_COLUMNS - cols
    if missing:
        print(f"   WARNING: missing expected columns: {missing}")
    else:
        print(f"   schema OK — all expected columns present")

    # Inspect Show HN rows in this file
    df = table.to_pydict()
    show_hn_count = 0
    zero_engagement = 0
    samples = []

    for i in range(n_rows):
        title = (df.get("title") or [""])[i] or ""
        if not title.upper().startswith("SHOW HN"):
            continue
        show_hn_count += 1
        score = (df.get("score") or [0])[i] or 0
        descendants = (df.get("descendants") or [0])[i] or 0
        if score <= 1 and descendants == 0:
            zero_engagement += 1
            if len(samples) < 3:
                raw_time = (df.get("time") or [0])[i]
                # parquet may store time as datetime or int
                if hasattr(raw_time, "timestamp"):
                    ts = int(raw_time.timestamp())
                else:
                    ts = int(raw_time or 0)
                samples.append({
                    "id": (df.get("id") or [None])[i],
                    "by": (df.get("by") or [""])[i],
                    "title": title[:80],
                    "score": score,
                    "descendants": descendants,
                    "time": ts,
                })

    print(f"\n   Show HN posts in this file: {show_hn_count:,}")
    print(f"   Zero-engagement Show HN:   {zero_engagement:,}")
    if samples:
        print("   Sample zero-engagement posts:")
        for s in samples:
            import datetime
            ts = datetime.datetime.fromtimestamp(s["time"]).strftime("%Y-%m-%d") if s["time"] else "?"
            print(f"     [{s['id']}] {s['by']:15s} {ts}  \"{s['title']}\"")


def main() -> None:
    print("── HN Graveyard probe ─────────────────────────────────────────────────")

    try:
        files = fetch_parquet_listing()
    except Exception as e:
        print(f"ERROR fetching listing: {e}")
        sys.exit(1)

    if not files:
        print("ERROR: no parquet files found in dataset")
        sys.exit(1)

    # Print summary of file listing
    total_size = sum(f.get("size", 0) for f in files)
    print(f"\n   {len(files)} files, {total_size / 1024 / 1024 / 1024:.2f} GB total")

    # Pick the most recent complete file to probe
    probe_url = files[-2]["url"] if len(files) >= 2 else files[0]["url"]

    try:
        probe_one_file(probe_url)
    except Exception as e:
        print(f"ERROR probing file: {e}")
        sys.exit(1)

    # Print sample of URLs for scale.py to use
    print(f"\n3. sample file URLs (first 5):")
    for f in files[:5]:
        print(f"   {f['url']}")

    print(f"\nprobe complete — {len(files)} files ready to process")
    print("next: python scale.py")


if __name__ == "__main__":
    main()
