// Small, dependency-free script for the live parts of the page:
// theme toggle, deploy panel (build + uptime data written by CI) and the GitHub project list.

(function () {
  "use strict";

  const root = document.documentElement;
  const body = document.body;
  const user = body.dataset.githubUser || "";
  const repo = body.dataset.githubRepo || "";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- storage helpers (storage can throw in private windows) ----------

  function load(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function save(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  // ---------- theme ----------

  const savedTheme = load("theme");
  if (savedTheme === "light" || savedTheme === "dark") root.dataset.theme = savedTheme;

  const toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      const current = root.dataset.theme ||
        (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      const next = current === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      save("theme", next);
    });
  }

  // ---------- masthead border on scroll + active nav link ----------

  const masthead = document.querySelector(".masthead");
  function onScroll() {
    if (masthead) masthead.classList.toggle("scrolled", window.scrollY > 8);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if ("IntersectionObserver" in window) {
    const links = new Map();
    document.querySelectorAll(".nav a[href^='#']").forEach(function (a) {
      links.set(a.getAttribute("href").slice(1), a);
    });
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        const link = links.get(entry.target.id);
        if (link && entry.isIntersecting) {
          links.forEach(function (l) { l.removeAttribute("aria-current"); });
          link.setAttribute("aria-current", "true");
        }
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    links.forEach(function (_, id) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
  }

  // ---------- profile + repo links ----------

  const profileUrl = user ? "https://github.com/" + user : "https://github.com/";
  document.querySelectorAll("[data-profile-link]").forEach(function (a) { a.href = profileUrl; });
  document.querySelectorAll("[data-repo-link]").forEach(function (a) {
    a.href = user && repo ? "https://github.com/" + user + "/" + repo : profileUrl;
  });

  // ---------- formatting ----------

  function setText(selector, text) {
    document.querySelectorAll(selector).forEach(function (el) { el.textContent = text; });
  }

  function timeAgo(date) {
    const seconds = Math.round((Date.now() - date.getTime()) / 1000);
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    const steps = [[60, "second"], [60, "minute"], [24, "hour"], [30, "day"], [12, "month"]];
    let value = -seconds;
    for (let i = 0; i < steps.length; i++) {
      if (Math.abs(value) < steps[i][0]) return rtf.format(value, steps[i][1]);
      value = Math.round(value / steps[i][0]);
    }
    return rtf.format(value, "year");
  }

  function formatDuration(totalSeconds) {
    if (!totalSeconds && totalSeconds !== 0) return "";
    const m = Math.floor(totalSeconds / 60);
    const s = Math.round(totalSeconds % 60);
    return m ? m + "m " + s + "s" : s + "s";
  }

  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error(url + " returned " + res.status);
      return res.json();
    });
  }

  // ---------- deploy panel ----------

  function renderBuild(build) {
    const commitLink = document.querySelector("[data-build='commit_link']");
    if (commitLink) {
      commitLink.textContent = build.short_sha || "local";
      commitLink.href = build.commit_url || "#";
    }
    setText("[data-build='short_sha']", build.short_sha || "local");
    setText("[data-build='message']", build.message ? build.message : "");

    const deployed = document.querySelector("[data-build='deployed_at']");
    if (deployed && build.deployed_at) {
      const date = new Date(build.deployed_at);
      deployed.textContent = timeAgo(date);
      deployed.title = date.toLocaleString();
    }

    const runLink = document.querySelector("[data-build='run_link']");
    if (runLink) {
      runLink.textContent = build.run_number ? "Pipeline #" + build.run_number : "Local build";
      runLink.href = build.run_url || "#";
    }
    if (build.duration_seconds) setText("[data-build='duration']", "in " + formatDuration(build.duration_seconds));

    const passed = build.checks || {};
    const items = Array.prototype.slice.call(document.querySelectorAll(".checks li"));
    items.forEach(function (li, i) {
      if (passed[li.dataset.check] !== "passed") return;
      if (reduceMotion) { li.classList.add("passed"); return; }
      window.setTimeout(function () { li.classList.add("passed"); }, 280 + i * 180);
    });
  }

  function renderStatus(status) {
    const checks = (status && status.checks) || [];
    const pulse = document.querySelector(".pulse");
    if (!checks.length) {
      setText("[data-status='uptime']", "First check pending");
      if (pulse) pulse.dataset.state = "up";
      return;
    }
    const ok = checks.filter(function (c) { return c.ok; }).length;
    const pct = (ok / checks.length) * 100;
    setText("[data-status='uptime']", (pct === 100 ? "100" : pct.toFixed(2)) + "%");
    const first = new Date(checks[0].at);
    const days = Math.max(1, Math.round((Date.now() - first.getTime()) / 86400000));
    setText("[data-status='window']", "over " + checks.length + " checks, " + days + (days === 1 ? " day" : " days"));

    const latest = checks[checks.length - 1];
    if (pulse) pulse.dataset.state = latest.ok ? "up" : "down";

    const bars = document.querySelector("[data-status='bars']");
    if (bars) {
      const recent = checks.slice(-40);
      const frag = document.createDocumentFragment();
      for (let i = recent.length; i < 40; i++) frag.appendChild(document.createElement("span"));
      recent.forEach(function (c) {
        const s = document.createElement("span");
        s.dataset.ok = String(Boolean(c.ok));
        s.title = new Date(c.at).toLocaleString() + (c.ok ? ", up in " + c.ms + " ms" : ", failed");
        frag.appendChild(s);
      });
      bars.replaceChildren(frag);
      bars.setAttribute("aria-label", "Last " + recent.length + " health checks, " + ok + " of " + checks.length + " passed overall");
    }
  }

  function renderVisit() {
    const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (!nav || !nav.responseStart) { setText("[data-live='ttfb']", "measured on next visit"); return; }
    const ttfb = Math.round(nav.responseStart - nav.startTime);
    setText("[data-live='ttfb']", "first byte in " + ttfb + " ms");
  }

  getJSON("data/build.json").then(renderBuild).catch(function () {
    setText("[data-build='deployed_at']", "local preview");
    const runLink = document.querySelector("[data-build='run_link']");
    if (runLink) runLink.textContent = "No pipeline data yet";
  });

  getJSON("data/status.json").then(renderStatus).catch(function () { renderStatus(null); });

  if (document.readyState === "complete") renderVisit();
  else window.addEventListener("load", function () { window.setTimeout(renderVisit, 0); });

  // ---------- projects from GitHub ----------

  const repoBox = document.querySelector("[data-repos]");

  function renderRepos(list) {
    if (!repoBox) return;
    const shown = list
      .filter(function (r) { return !r.fork && !r.archived && r.name !== repo && r.name !== user; })
      .slice(0, 6);
    if (!shown.length) return; // keep the friendly empty state
    const frag = document.createDocumentFragment();
    shown.forEach(function (r) {
      const card = document.createElement("article");
      card.className = "repo";
      const h = document.createElement("h3");
      const a = document.createElement("a");
      a.href = r.html_url;
      a.textContent = r.name;
      h.appendChild(a);
      card.appendChild(h);
      if (r.description) {
        const p = document.createElement("p");
        p.textContent = r.description;
        card.appendChild(p);
      }
      const meta = document.createElement("p");
      meta.className = "meta";
      [r.language, r.stargazers_count ? r.stargazers_count + " stars" : "", r.pushed_at ? "updated " + timeAgo(new Date(r.pushed_at)) : ""]
        .filter(Boolean)
        .forEach(function (t) {
          const span = document.createElement("span");
          span.textContent = t;
          meta.appendChild(span);
        });
      card.appendChild(meta);
      frag.appendChild(card);
    });
    repoBox.replaceChildren(frag);
  }

  // The build writes a snapshot so the list shows instantly; then we try the live API.
  getJSON("data/repos.json").then(renderRepos).catch(function () { /* no snapshot */ }).then(function () {
    if (!user || user.indexOf("{{") === 0) return;
    return getJSON("https://api.github.com/users/" + encodeURIComponent(user) + "/repos?sort=pushed&per_page=30")
      .then(renderRepos)
      .catch(function () { /* rate limited or offline: keep the snapshot */ });
  });
})();
