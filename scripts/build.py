#!/usr/bin/env python3
"""Build the site into dist/.

Copies src/, fills in template values and writes the JSON files the page
reads at runtime:

  data/build.json   commit, run and check results for this deploy
  data/repos.json   snapshot of public GitHub repos
  data/status.json  rolling history of health checks

Standard library only, so it runs the same on a laptop and in CI.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
DIST = ROOT / "dist"

TEMPLATED = {".html"}
CHECK_NAMES = ("html", "links", "dockerfile", "trivy", "smoke")
HISTORY_DAYS = 30
USER_AGENT = "portfolio-build"


def log(msg: str) -> None:
    print(f"[build] {msg}", flush=True)


def git(*args: str) -> str:
    try:
        return subprocess.check_output(["git", *args], cwd=ROOT, text=True, stderr=subprocess.DEVNULL).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return ""


def http_get(url: str, token: str | None = None, timeout: float = 10.0) -> tuple[int, bytes, float]:
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    start = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            body = res.read()
            return res.status, body, (time.perf_counter() - start) * 1000
    except urllib.error.HTTPError as err:
        return err.code, b"", (time.perf_counter() - start) * 1000


def asset_version() -> str:
    digest = hashlib.sha256()
    for path in sorted((SRC / "assets").rglob("*")):
        if path.is_file():
            digest.update(path.read_bytes())
    return digest.hexdigest()[:10]


PARTIAL = re.compile(r"\{\{>\s*([\w-]+)\s*\}\}")


def load_partials() -> dict[str, str]:
    folder = SRC / "_partials"
    if not folder.exists():
        return {}
    return {p.stem: p.read_text(encoding="utf-8") for p in folder.glob("*.html")}


def render_page(text: str, partials: dict[str, str], values: dict[str, str]) -> str:
    # Partials can't nest, which keeps this predictable. Values are filled in after.
    def include(match: re.Match) -> str:
        name = match.group(1)
        if name not in partials:
            raise SystemExit(f"[build] unknown partial: {name}")
        return partials[name]

    text = PARTIAL.sub(include, text)
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    leftover = re.findall(r"\{\{[^}]+\}\}", text)
    if leftover:
        raise SystemExit(f"[build] unfilled placeholders: {sorted(set(leftover))}")
    return text


def copy_source(values: dict[str, str]) -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(SRC, DIST, ignore=shutil.ignore_patterns("_partials"))
    partials = load_partials()
    pages = 0
    for path in DIST.rglob("*"):
        if path.is_file() and path.suffix in TEMPLATED:
            depth = len(path.relative_to(DIST).parts) - 1
            page_values = {**values, "root": "../" * depth or "./"}
            path.write_text(render_page(path.read_text(encoding="utf-8"), partials, page_values), encoding="utf-8")
            pages += 1
    (DIST / ".nojekyll").write_text("")
    log(f"copied src/ to dist/ ({pages} pages, {sum(1 for p in DIST.rglob('*') if p.is_file())} files)")


def build_info(repo_slug: str, checks_passed: bool) -> dict:
    sha = os.environ.get("GITHUB_SHA") or git("rev-parse", "HEAD") or "local"
    server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    run_id = os.environ.get("GITHUB_RUN_ID")
    started = os.environ.get("RUN_STARTED_AT")
    now = datetime.now(UTC)

    duration = None
    if started:
        try:
            duration = int((now - datetime.fromisoformat(started)).total_seconds())
        except ValueError:
            duration = None

    info = {
        "sha": sha,
        "short_sha": sha[:7],
        "message": git("log", "-1", "--format=%s"),
        "commit_url": f"{server}/{repo_slug}/commit/{sha}" if repo_slug and sha != "local" else None,
        "run_number": os.environ.get("GITHUB_RUN_NUMBER"),
        "run_url": f"{server}/{repo_slug}/actions/runs/{run_id}" if repo_slug and run_id else None,
        "trigger": os.environ.get("GITHUB_EVENT_NAME", "local"),
        "deployed_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "duration_seconds": duration,
        # The deploy job only runs after every check job succeeded (see pipeline.yml),
        # so "passed" here is a fact about this build, not a decoration.
        "checks": {name: ("passed" if checks_passed else "not run") for name in CHECK_NAMES},
    }
    return info


def fetch_repos(user: str, token: str | None) -> list:
    if not user:
        return []
    status, body, _ = http_get(f"https://api.github.com/users/{user}/repos?sort=pushed&per_page=30", token)
    if status != 200:
        log(f"repo snapshot skipped (GitHub API returned {status})")
        return []
    keep = ("name", "html_url", "description", "language", "stargazers_count", "pushed_at", "fork", "archived")
    repos = [{k: r.get(k) for k in keep} for r in json.loads(body)]
    log(f"repo snapshot: {len(repos)} repos")
    return repos


def update_status(site_url: str | None) -> dict:
    """Pull the history from the live site, probe it once, keep the last 30 days."""
    history: list = []
    if site_url:
        status, body, _ = http_get(site_url.rstrip("/") + "/data/status.json")
        if status == 200:
            try:
                history = json.loads(body).get("checks", [])
            except ValueError:
                history = []
        # A 404 before the site has ever answered means it hasn't launched yet,
        # not that it went down. Leave those out so launch day doesn't count as an outage.
        if not any(c.get("ok") for c in history):
            history = [c for c in history if c.get("code") != 404]

        probe_status, _, ms = http_get(site_url.rstrip("/") + "/")
        ok = probe_status == 200
        if not ok and probe_status == 404 and not history:
            log(f"health check skipped: {site_url} is not live yet")
            return {"checks": []}
        history.append({
            "at": datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "ok": ok,
            "code": probe_status,
            "ms": round(ms),
        })
        log(f"health check {site_url}: {'up' if ok else 'DOWN'} ({probe_status}, {round(ms)} ms)")

    cutoff = datetime.now(UTC) - timedelta(days=HISTORY_DAYS)
    history = [c for c in history if datetime.fromisoformat(c["at"]) >= cutoff]
    return {"checks": history}


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--site-url", default=os.environ.get("SITE_URL"), help="live URL to read status from and probe")
    parser.add_argument("--checks-passed", action="store_true", help="mark CI checks as passed in build.json")
    parser.add_argument("--offline", action="store_true", help="skip network calls (local preview)")
    args = parser.parse_args()

    repo_slug = os.environ.get("GITHUB_REPOSITORY", "")
    user = os.environ.get("GITHUB_REPOSITORY_OWNER") or (repo_slug.split("/")[0] if repo_slug else "")
    repo_name = repo_slug.split("/")[1] if "/" in repo_slug else ""
    token = os.environ.get("GITHUB_TOKEN")

    # Absolute path the site is served from, for pages like 404.html that can appear at any URL.
    base_path = urlparse(args.site_url).path if args.site_url else "/"
    if not base_path.endswith("/"):
        base_path += "/"

    copy_source({
        "github_user": user,
        "github_repo": repo_name,
        "asset_version": asset_version(),
        "base_path": base_path,
    })

    data = DIST / "data"
    write_json(data / "build.json", build_info(repo_slug, args.checks_passed))
    write_json(data / "repos.json", [] if args.offline else fetch_repos(user, token))
    write_json(data / "status.json", update_status(None if args.offline else args.site_url))
    log("done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
