"""
URL aliveness worker for Phase 2.

Each Burla worker receives a batch of (post_id, url) pairs and performs
an HTTP GET for each, checking whether the linked project is still alive.

Handles:
  - Timeouts (15s connect, 20s read)
  - Redirects (up to 5 hops, records final URL)
  - Common error classes: DNS failure, connection refused, SSL error, 4xx, 5xx

Output per URL:
  {
    "post_id": int,
    "url":     str,
    "alive":   bool,
    "status":  int | null,
    "final_url": str | null,
    "redirected": bool,
    "error":   str | null,    # null if alive
  }

Written to /workspace/shared/hn/url_shards/{shard_id}.json
"""
from __future__ import annotations

import json
import os
import time
from typing import Any

OUTPUT_DIR = "/workspace/shared/hn/url_shards"

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
}


def check_url(post_id: int, url: str) -> dict[str, Any]:
    """Perform one HTTP GET and return aliveness result."""
    import requests
    from requests.exceptions import (
        ConnectionError, Timeout, TooManyRedirects, SSLError, RequestException
    )

    if not url or not url.startswith(("http://", "https://")):
        return {
            "post_id": post_id, "url": url,
            "alive": False, "status": None,
            "final_url": None, "redirected": False,
            "error": "invalid_url",
        }

    try:
        session = requests.Session()
        session.max_redirects = 5
        resp = session.get(
            url,
            headers=_BROWSER_HEADERS,
            timeout=(15, 20),
            allow_redirects=True,
            stream=True,
        )
        resp.close()

        final_url = resp.url
        redirected = final_url.rstrip("/") != url.rstrip("/")
        alive = resp.status_code < 400

        return {
            "post_id":   post_id,
            "url":       url,
            "alive":     alive,
            "status":    resp.status_code,
            "final_url": final_url if redirected else None,
            "redirected": redirected,
            "error":     None if alive else f"http_{resp.status_code}",
        }

    except Timeout:
        return {"post_id": post_id, "url": url, "alive": False, "status": None,
                "final_url": None, "redirected": False, "error": "timeout"}
    except SSLError:
        return {"post_id": post_id, "url": url, "alive": False, "status": None,
                "final_url": None, "redirected": False, "error": "ssl_error"}
    except TooManyRedirects:
        return {"post_id": post_id, "url": url, "alive": False, "status": None,
                "final_url": None, "redirected": True, "error": "redirect_loop"}
    except ConnectionError as e:
        err_str = str(e)
        if "Name or service not known" in err_str or "Temporary failure in name resolution" in err_str:
            error = "dns_failure"
        elif "Connection refused" in err_str:
            error = "connection_refused"
        else:
            error = "connection_error"
        return {"post_id": post_id, "url": url, "alive": False, "status": None,
                "final_url": None, "redirected": False, "error": error}
    except RequestException as e:
        return {"post_id": post_id, "url": url, "alive": False, "status": None,
                "final_url": None, "redirected": False, "error": f"request_error:{str(e)[:60]}"}


def check_batch(items: list[tuple[int, str]], shard_id: str) -> dict[str, Any]:
    """
    Runs on a Burla worker. Checks aliveness for a batch of (post_id, url) pairs.
    Results written to shared disk.
    """
    import os, json

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results = []
    for post_id, url in items:
        result = check_url(post_id, url)
        results.append(result)
        # Small delay to avoid hammering individual hosts
        time.sleep(0.05)

    n_alive = sum(1 for r in results if r["alive"])

    payload = {
        "shard_id": shard_id,
        "n_checked": len(results),
        "n_alive":   n_alive,
        "n_dead":    len(results) - n_alive,
        "results":   results,
    }

    out_path = os.path.join(OUTPUT_DIR, f"{shard_id}.json")
    with open(out_path, "w") as f:
        json.dump(payload, f)

    return {
        "shard_id": shard_id,
        "n_checked": len(results),
        "n_alive":   n_alive,
    }
