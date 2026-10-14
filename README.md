# gopala-portfolio

My personal site. It's plain HTML, CSS and JavaScript with no framework, but I run it like a production service: every change goes through checks, gets packaged as a container, and the live site is health checked on a schedule.

The panel at the top of the homepage reads its data from this pipeline, so the commit, run number, checks and uptime you see there are real.

## How it works

```
git push ──> site checks ──┐
                           ├──> deploy to GitHub Pages ──> health check every 3h
        container checks ──┘
```

**Site checks**
- `ruff` on the build script
- `html-validate` on the generated HTML
- `lychee` for broken internal links and anchors

**Container checks**
- `hadolint` on the Dockerfile
- `trivy` for secrets and misconfigurations in the repo, then for critical CVEs in the image
- smoke test: start the container, hit `/healthz`, check the page, the JSON and the security headers
- on `main`, push the image to GitHub Container Registry

**Deploy** only runs when both jobs pass. It builds the site again with live data:
- `data/build.json` commit, run and timing for this deploy
- `data/repos.json` snapshot of my public repos (the page also refreshes this from the GitHub API)
- `data/status.json` health check history

### Uptime without a database

There's no server and nothing to pay for, so the uptime history lives on the site itself. Every scheduled run downloads the current `status.json` from the live site, probes the homepage, appends the result, drops anything older than 30 days, and deploys again. No bot commits cluttering the history.

## Run it locally

You need Python 3.10+. Nothing to install.

```bash
python3 scripts/build.py --offline
python3 -m http.server 8000 --directory dist
```

Or in a container:

```bash
python3 scripts/build.py --offline
docker build -t portfolio .
docker run --rm -p 8080:8080 portfolio
```

## Layout

```
src/                 the site (HTML, CSS, JS, résumé PDF)
scripts/build.py     build step, writes dist/ and the data files
deploy/nginx.conf    nginx config for the container (security headers, caching, /healthz)
Dockerfile           unprivileged nginx image
.github/workflows/   the pipeline
```

## Design notes

Spacing and the main column split follow the golden ratio (61.8 / 38.2). Type is IBM Plex Sans, with Plex Mono only where the content is actual pipeline output. Colors are a muted navy palette with a dark mode that follows the system setting.

## Cost

$0. GitHub Pages, GitHub Actions on a public repo and GHCR are all free.
