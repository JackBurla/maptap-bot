"""
Phase 2: Fan out URL aliveness checks across 1,000 Burla workers.

Reads all shard files from /workspace/shared/hn/shards/ (written by scale.py),
collects all unique URLs from zero-engagement Show HN posts,
then dispatches batches to url_check.check_batch via remote_parallel_map.

Results written to /workspace/shared/hn/url_shards/

Usage:
    python url_scale.py [--batch-size N] [--limit N]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
from pathlib import Path

from burla import remote_parallel_map

from url_check import check_batch

SHARD_DIR     = "/workspace/shared/hn/shards"
URL_SHARD_DIR = "/workspace/shared/hn/url_shards"

HERE = Path(__file__).parent
SUMMARY_PATH = HERE / "samples" / "url_summary.json"


# ── cluster-side URL collector ────────────────────────────────────────────────

def collect_and_write_urls(_: int) -> int:
    """
    Runs on a single Burla worker with access to /workspace/shared.
    Reads all shard files, collects (post_id, url) pairs for zero-engagement
    posts, and writes them to /workspace/shared/hn/url_list.json.
    Returns the count of URLs collected.
    """
    import json, os

    shard_dir  = "/workspace/shared/hn/shards"
    out_path   = "/workspace/shared/hn/url_list.json"

    if not os.path.exists(shard_dir):
        return 0

    items: list[list] = []
    seen_urls: set[str] = set()

    for fname in sorted(os.listdir(shard_dir)):
        if not fname.endswith(".json"):
            continue
        try:
            with open(os.path.join(shard_dir, fname)) as f:
                shard = json.load(f)
        except Exception:
            continue
        for post in shard.get("posts", []):
            if not post.get("zero_engagement"):
                continue
            url = (post.get("url") or "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            items.append([post["id"], url])

    with open(out_path, "w") as f:
        json.dump(items, f)

    return len(items)


def read_urls_from_cluster(_: int) -> list[list]:
    """Read the collected URL list from shared disk."""
    import json
    with open("/workspace/shared/hn/url_list.json") as f:
        return json.load(f)


def check_batch_from_disk(shard_idx: int, batch_size: int, shard_id: str) -> dict:
    """
    Runs on a Burla worker. Reads the URL list from shared disk,
    takes the slice for this shard, and runs URL aliveness checks.
    Writes results to /workspace/shared/hn/url_shards/{shard_id}.json.
    """
    import json, os

    url_list_path = "/workspace/shared/hn/url_list.json"
    output_dir    = "/workspace/shared/hn/url_shards"
    os.makedirs(output_dir, exist_ok=True)

    with open(url_list_path) as f:
        all_items = json.load(f)

    start = shard_idx * batch_size
    end   = start + batch_size
    batch = all_items[start:end]

    if not batch:
        return {"shard_id": shard_id, "n_checked": 0, "n_alive": 0}

    # Inline the URL check logic (no import from url_check.py on workers)
    import requests
    from requests.exceptions import ConnectionError, Timeout, TooManyRedirects, SSLError, RequestException

    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "text/html,*/*;q=0.8",
    }

    def _check(post_id, url):
        if not url or not url.startswith(("http://", "https://")):
            return {"post_id": post_id, "url": url, "alive": False, "status": None,
                    "final_url": None, "redirected": False, "error": "invalid_url"}
        try:
            session = requests.Session()
            session.max_redirects = 5
            # Lower timeouts: dead hosts fail faster; we only need headers
            resp = session.get(url, headers=HEADERS, timeout=(8, 12),
                               allow_redirects=True, stream=True)
            resp.close()
            final_url  = resp.url
            redirected = final_url.rstrip("/") != url.rstrip("/")
            alive      = resp.status_code < 400
            return {"post_id": post_id, "url": url, "alive": alive,
                    "status": resp.status_code,
                    "final_url": final_url if redirected else None,
                    "redirected": redirected,
                    "error": None if alive else f"http_{resp.status_code}"}
        except Timeout:
            return {"post_id": post_id, "url": url, "alive": False, "status": None,
                    "final_url": None, "redirected": False, "error": "timeout"}
        except SSLError:
            return {"post_id": post_id, "url": url, "alive": False, "status": None,
                    "final_url": None, "redirected": False, "error": "ssl_error"}
        except TooManyRedirects:
            return {"post_id": post_id, "url": url, "alive": False, "status": None,
                    "final_url": None, "redirected": True, "error": "redirect_loop"}
        except (ConnectionError, RequestException) as e:
            err = "dns_failure" if "Name or service" in str(e) or "Temporary failure" in str(e) else "connection_error"
            return {"post_id": post_id, "url": url, "alive": False, "status": None,
                    "final_url": None, "redirected": False, "error": err}

    results = []
    for row in batch:
        results.append(_check(row[0], row[1]))

    n_alive = sum(1 for r in results if r["alive"])
    payload = {"shard_id": shard_id, "n_checked": len(results),
               "n_alive": n_alive, "n_dead": len(results) - n_alive, "results": results}

    with open(os.path.join(output_dir, f"{shard_id}.json"), "w") as f:
        json.dump(payload, f)

    return {"shard_id": shard_id, "n_checked": len(results), "n_alive": n_alive}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-size", type=int, default=200, help="URLs per worker")
    ap.add_argument("--limit", type=int, default=0, help="debug: check only first N URLs")
    ap.add_argument("--max-parallelism", type=int, default=1000)
    args = ap.parse_args()

    SUMMARY_PATH.parent.mkdir(parents=True, exist_ok=True)

    # Step 1: collect URLs on the cluster and write to shared disk
    print("collecting zero-engagement URLs from cluster shards ...")
    counts = remote_parallel_map(
        collect_and_write_urls,
        [0],
        func_cpu=1,
        func_ram=8,
        grow=True,
        spinner=True,
    )
    n_urls = counts[0]
    print(f"  {n_urls:,} unique URLs written to cluster shared disk")

    # Step 2: read them back in a separate cluster call (avoids large return value)
    print("reading URL list from cluster ...")
    raw_items = remote_parallel_map(
        read_urls_from_cluster,
        [0],
        func_cpu=1,
        func_ram=4,
        grow=True,
        spinner=True,
    )
    items = [(row[0], row[1]) for row in raw_items[0]]
    print(f"  retrieved {len(items):,} URLs")

    if args.limit:
        items = items[: args.limit]
        print(f"  (limited to {args.limit} URLs for debug)")

    if not items:
        raise SystemExit("No zero-engagement URLs found — did scale.py complete?")

    # Build jobs: each worker gets (shard_idx, batch_size, shard_id)
    # Workers read their URL slice from shared disk — no large input upload
    n_batches = math.ceil(len(items) / args.batch_size)
    jobs = [
        (i, args.batch_size, f"url_{i:05d}")
        for i in range(n_batches)
    ]

    print(f"\n{len(items):,} URLs → {len(jobs):,} batches × {args.batch_size} — fanning out ...")

    t0 = time.time()
    results = remote_parallel_map(
        check_batch_from_disk,
        jobs,
        func_cpu=1,
        func_ram=1,
        grow=True,
        max_parallelism=args.max_parallelism,
        spinner=True,
    )
    elapsed = time.time() - t0

    successes = [r for r in results if "error" not in r]
    total_checked = sum(r.get("n_checked", 0) for r in successes)
    total_alive   = sum(r.get("n_alive", 0) for r in successes)
    total_dead    = total_checked - total_alive

    summary = {
        "elapsed_seconds":    round(elapsed, 2),
        "elapsed_minutes":    round(elapsed / 60, 2),
        "n_batches":          len(jobs),
        "n_succeeded":        len(successes),
        "n_urls_checked":     total_checked,
        "n_alive":            total_alive,
        "n_dead":             total_dead,
        "pct_dead":           round(100 * total_dead / max(total_checked, 1), 1),
        "throughput_urls_per_sec": round(total_checked / max(elapsed, 1), 1),
    }
    SUMMARY_PATH.write_text(json.dumps(summary, indent=2))

    print(f"\n{'=' * 70}")
    print(f"elapsed:   {summary['elapsed_minutes']} min  "
          f"({summary['throughput_urls_per_sec']:,.0f} URLs/sec)")
    print(f"checked:   {total_checked:,}")
    print(f"alive:     {total_alive:,}  ({100 - summary['pct_dead']:.1f}%)")
    print(f"dead:      {total_dead:,}  ({summary['pct_dead']}%) — the graveyard")
    print(f"wrote {SUMMARY_PATH}")
    print("\nnext: python reduce.py")


if __name__ == "__main__":
    main()
