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
CONTENT_DIR = ROOT / "content"
EACH = re.compile(r"\{\{#each\s+([.\w-]+)\s*\}\}")
IF = re.compile(r"\{\{#if\s+([.\w-]+)\s*\}\}")
TAG = re.compile(r"\{\{\s*([.\w-]+)\s*\}\}")
BLOCK_TAG = re.compile(r"\{\{(#each|#if|/each|/if)\b[^}]*\}\}")


# ---------- content files ----------
#
# content/<name>.txt holds the words for a page. The format is deliberately plain:
#
#   [section]
#   key: a value, which can continue on lines
#     that start with spaces.
#   list:
#     - first item
#     - second item | with a second part
#
# Templates read them as {{name.section.key}}, or loop over a file with {{#each name}}.


def parse_content(path: Path) -> dict[str, dict[str, str | list[str]]]:
    sections: dict[str, dict[str, str | list[str]]] = {}
    current: dict[str, str | list[str]] | None = None
    key: str | None = None
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#") and not raw.startswith((" ", "\t")):
            continue
        header = re.fullmatch(r"\[([\w-]+)\]", line)
        if header:
            current = sections.setdefault(header.group(1), {})
            key = None
            continue
        if current is None:
            raise SystemExit(f"[build] {path.name}:{number}: text before the first [section]")
        if raw.startswith((" ", "\t")):
            if key is None:
                raise SystemExit(f"[build] {path.name}:{number}: indented line without a key above it")
            text = line.strip()
            value = current[key]
            if text.startswith("- "):
                if value == "":
                    current[key] = value = []
                if not isinstance(value, list):
                    raise SystemExit(f"[build] {path.name}:{number}: mixed text and list under '{key}'")
                value.append(text[2:].strip())
            elif isinstance(value, list):
                value[-1] += " " + text
            else:
                current[key] = (value + " " + text).strip()
            continue
        match = re.fullmatch(r"([\w-]+):\s*(.*)", line)
        if not match:
            raise SystemExit(f"[build] {path.name}:{number}: expected 'key: value', got: {line[:60]}")
        key = match.group(1)
        current[key] = match.group(2).strip()
    return sections


def load_content() -> dict[str, dict]:
    if not CONTENT_DIR.exists():
        return {}
    return {p.stem: parse_content(p) for p in sorted(CONTENT_DIR.glob("*.txt"))}


def inline(text: str, root: str) -> str:
    """Escape text, then allow **bold**, *emphasis* and [links](url). `@/` in a link means the site root."""
    text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", text)

    def link(m: re.Match) -> str:
        label, url = m.group(1), m.group(2)
        if url.startswith("@/"):
            return f'<a href="{root}{url[2:]}">{label}</a>'
        if url.startswith(("http://", "https://")):
            return f'<a href="{url}" target="_blank" rel="noopener noreferrer">{label}</a>'
        if url.startswith("mailto:"):
            return f'<a href="{url}">{label}</a>'
        return f'<a href="{url}">{label}</a>'

    return re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", link, text)


def lookup(path: str, scope: list, content: dict, strict: bool = True):
    """Resolve a dotted name. `.x` reads from the innermost loop item, `a.b.c` from content files."""
    if path.startswith("."):
        item = scope[-1] if scope else None
        name = path[1:]
        if name == "":
            return item[0] if isinstance(item, list) and len(item) == 1 else item
        if isinstance(item, dict):
            return item.get(name, "")
        if isinstance(item, list) and name.isdigit():
            return item[int(name)] if int(name) < len(item) else ""
        return ""
    parts = path.split(".")
    node = content
    for part in parts:
        if isinstance(node, dict) and part in node:
            node = node[part]
        elif isinstance(node, list) and part.isdigit() and int(part) < len(node):
            node = node[int(part)]
        elif strict:
            raise SystemExit(f"[build] content not found: {path}")
        else:
            return ""
    return node


def split_block(text: str, start: int, open_tag: str, close_tag: str) -> tuple[str, int]:
    """Return the body of a block and the index just after its closing tag, honouring nesting."""
    depth = 1
    for m in BLOCK_TAG.finditer(text, start):
        tag = m.group(1)
        depth += 1 if tag == open_tag else -1 if tag == close_tag else 0
        if depth == 0:
            return text[start:m.start()], m.end()
    raise SystemExit(f"[build] missing {{{{{close_tag}}}}}")


def render_content(text: str, scope: list, content: dict, root: str) -> str:
    out: list[str] = []
    pos = 0
    while True:
        m = re.compile(r"\{\{(#each|#if)\s+([.\w-]+)\s*\}\}").search(text, pos)
        if not m:
            out.append(render_tags(text[pos:], scope, content, root))
            return "".join(out)
        out.append(render_tags(text[pos:m.start()], scope, content, root))
        kind, name = m.group(1), m.group(2)
        body, pos = split_block(text, m.end(), kind, "/each" if kind == "#each" else "/if")
        value = lookup(name, scope, content, strict=kind != "#if")
        if kind == "#if":
            if value:
                out.append(render_content(body, scope, content, root))
            continue
        if isinstance(value, dict) and all(isinstance(v, dict) for v in value.values()):
            items = [{"id": k, **v} for k, v in value.items()]
        elif isinstance(value, list):
            items = [_list_item(i) for i in value]
        else:
            items = []
        for item in items:
            out.append(render_content(body, [*scope, item], content, root))


def _list_item(raw: str) -> list[str]:
    return [part.strip() for part in raw.split(" | ")]


def render_tags(text: str, scope: list, content: dict, root: str) -> str:
    def sub(m: re.Match) -> str:
        name = m.group(1)
        if "." not in name:
            return m.group(0)  # plain values like {{root}} are filled in later
        value = lookup(name, scope, content)
        if isinstance(value, list):
            raise SystemExit(f"[build] '{name}' is a list; use {{{{#each {name}}}}}")
        if isinstance(value, dict):
            raise SystemExit(f"[build] '{name}' is a section; pick a key from it")
        return inline(str(value), root)

    return TAG.sub(sub, text)


def load_partials() -> dict[str, str]:
    folder = SRC / "_partials"
    if not folder.exists():
        return {}
    return {p.stem: p.read_text(encoding="utf-8") for p in folder.glob("*.html")}


def render_page(text: str, partials: dict[str, str], values: dict[str, str], content: dict | None = None) -> str:
    # Partials can't nest, which keeps this predictable. Content is read next, then plain values.
    def include(match: re.Match) -> str:
        name = match.group(1)
        if name not in partials:
            raise SystemExit(f"[build] unknown partial: {name}")
        return partials[name]

    text = PARTIAL.sub(include, text)
    text = render_content(text, [], {**(content or {}), "site": (content or {}).get("site", {})}, values["root"])
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", value)
    leftover = re.findall(r"\{\{[^}]+\}\}", text)
    if leftover:
        raise SystemExit(f"[build] unfilled placeholders: {sorted(set(leftover))}")
    return text


def case_pages(content: dict) -> dict[str, dict]:
    """Case study pages come from content/cases.txt, then content/projects.txt, one section per page."""
    return {**content.get("cases", {}), **content.get("projects", {})}


def copy_source(values: dict[str, str]) -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    shutil.copytree(SRC, DIST, ignore=shutil.ignore_patterns("_partials", "_templates"))
    partials = load_partials()
    content = load_content()
    pages = 0

    def write(path: Path, text: str) -> None:
        nonlocal pages
        depth = len(path.relative_to(DIST).parts) - 1
        page_values = {**values, "root": "../" * depth or "./"}
        path.write_text(render_page(text, partials, page_values, content), encoding="utf-8")
        pages += 1

    for path in sorted(DIST.rglob("*")):
        if path.is_file() and path.suffix in TEMPLATED:
            write(path, path.read_text(encoding="utf-8"))

    template = (SRC / "_templates" / "case.html").read_text(encoding="utf-8")
    slugs = list(case_pages(content))
    for i, slug in enumerate(slugs):
        data = case_pages(content)[slug]
        # Previous and next links are worked out here so the content files stay simple.
        cases = case_pages(content)
        neighbours = {
            "prev_slug": slugs[i - 1] if i else "",
            "prev_title": cases[slugs[i - 1]]["title"] if i else "",
            "next_slug": slugs[i + 1] if i + 1 < len(slugs) else "this-website",
            "next_title": cases[slugs[i + 1]]["title"] if i + 1 < len(slugs) else "This website",
        }
        content["case"] = {"current": {**data, **neighbours, "slug": slug}}
        target = DIST / "work" / slug / "index.html"
        target.parent.mkdir(parents=True, exist_ok=True)
        write(target, template)
    content.pop("case", None)
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
