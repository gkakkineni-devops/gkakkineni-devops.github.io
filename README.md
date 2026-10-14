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

You need Python 3.11+. Nothing to install.

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
src/                 the site: one folder per page, plus assets and the résumé PDF
src/_partials/       shared head, header, footer and call to action
scripts/build.py     build step: fills in partials and links, writes dist/ and the data files
deploy/nginx.conf    nginx config for the container (security headers, caching, /healthz)
Dockerfile           unprivileged nginx image
.github/workflows/   the pipeline
```

## Pages

Home, About, Work (five case studies plus a write-up of this site), Experience and Contact. Shared pieces live in `src/_partials` and get stitched in at build time, so there's still no framework.

## What's interactive

- **Live deploy panel**: commit, pipeline run, checks and uptime, all read from files the pipeline writes.
- **Deploy playground**: pick a clean release, a vulnerable dependency or a bug that only shows under real traffic, then watch the pipeline ship it, block it at the scan, or roll the canary back on its own.
- **Case studies**: problem, what I did, what changed.
- **Tool finder**: tap a tool to see where I've used it.
- **Projects**: pulled from the GitHub API, so new repos show up without editing the page.

## Design notes

Three moods drive the colors: a deep violet-black "shadow" base, a warm "sage" orange for anything live or moving, and a soft "cloud" white for text and the light theme. Spacing and the main column split follow the golden ratio (61.8 / 38.2). Type is IBM Plex Sans, with Plex Mono only where the content is actual pipeline output. Dark and light themes follow the system setting, with a toggle.

## Cost

$0. GitHub Pages, GitHub Actions on a public repo and GHCR are all free.

## Editing the words

All the text lives in `content/`, one file per page, so you never have to touch HTML to change wording.

| File | What it controls |
| --- | --- |
| `site.txt` | Menu, footer, the email box at the bottom, your email and LinkedIn |
| `home.txt` | Home page, including the hero at the top |
| `about.txt`, `story.txt` | About page: facts, beliefs, education, and the story |
| `jobs.txt`, `experience.txt` | Experience page, one section per job |
| `work.txt`, `cases.txt` | Work page and every case study (one `[section]` = one page) |
| `playground.txt` | Playground page text |
| `contact.txt`, `notfound.txt` | Contact and 404 pages |

The format is plain: `[section]` headers, `key: text` lines, and `- item` lines for lists. A ` | ` inside a list item splits it into parts. In any text you can use `**bold**`, `*emphasis*` and `[link](https://...)`. Use `[text](@/about/)` to link to another page on the site. Edit on GitHub, commit, and the pipeline rebuilds and deploys it. A typo in the format fails the build with the file and line, so a broken edit never goes live.

Still in the HTML: the tool buttons on the About page, the body of the "This website" case study, and the messages the playground prints (`src/assets/js/site.js`).
