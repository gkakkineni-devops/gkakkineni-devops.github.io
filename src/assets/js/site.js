// Everything that moves on the page, with no dependencies.
// Theme, mobile menu, the live deploy panel, impact counters, the deploy playground,
// the skill finder, the GitHub project list and copy-to-clipboard.


(function () {
  "use strict";

  const root = document.documentElement;
  const body = document.body;
  const user = body.dataset.githubUser || "";
  const repo = body.dataset.githubRepo || "";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.prototype.slice.call((el || document).querySelectorAll(sel));
  const wait = (ms) => new Promise((r) => window.setTimeout(r, reduceMotion ? Math.min(ms, 60) : ms));

  // Storage can throw in private windows, so wrap it.
  function load(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function save(key, value) { try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ } }

  function setText(selector, text) { $$(selector).forEach((el) => { el.textContent = text; }); }

  // ---------- theme ----------

  const savedTheme = load("theme");
  if (savedTheme === "light" || savedTheme === "dark") root.dataset.theme = savedTheme;

  const toggle = $(".theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const current = root.dataset.theme ||
        (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
      const next = current === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      save("theme", next);
    });
  }

  // ---------- masthead + active nav link ----------

  const masthead = $(".masthead");
  const onScroll = () => { if (masthead) masthead.classList.toggle("scrolled", window.scrollY > 8); };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Mark the current section in the nav.
  const page = body.dataset.page;
  $$("[data-nav]").forEach((a) => { if (a.dataset.nav === page) a.setAttribute("aria-current", "page"); });

  // Mobile menu.
  const navToggle = $(".nav-toggle");
  const navLinks = $("#nav-links");
  if (navToggle && navLinks) {
    navToggle.addEventListener("click", () => {
      const open = navToggle.getAttribute("aria-expanded") !== "true";
      navToggle.setAttribute("aria-expanded", String(open));
      navLinks.classList.toggle("open", open);
    });
    navLinks.addEventListener("click", (e) => {
      if (e.target.closest("a")) { navToggle.setAttribute("aria-expanded", "false"); navLinks.classList.remove("open"); }
    });
  }

  // Highlight the case study table of contents as you read.
  const tocLinks = $$(".case-toc a");
  if (tocLinks.length && "IntersectionObserver" in window) {
    const tocObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        tocLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + entry.target.id));
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    tocLinks.forEach((a) => { const el = document.getElementById(a.getAttribute("href").slice(1)); if (el) tocObserver.observe(el); });
  }

  // ---------- formatting ----------

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

  function formatDuration(total) {
    if (!total && total !== 0) return "";
    const m = Math.floor(total / 60);
    const s = Math.round(total % 60);
    return m ? m + "m " + s + "s" : s + "s";
  }

  function getJSON(url) {
    return fetch(url, { cache: "no-store" }).then((res) => {
      if (!res.ok) throw new Error(url + " returned " + res.status);
      return res.json();
    });
  }

  // ---------- live deploy panel ----------

  const dataRoot = body.dataset.root || "./";

  function renderBuild(build) {
    const commitLink = $("[data-build='commit_link']");
    if (commitLink) {
      commitLink.textContent = build.short_sha || "local";
      if (build.commit_url) commitLink.href = build.commit_url;
    }
    $$("[data-build='short_sha_link']").forEach((a) => {
      a.textContent = build.short_sha || "local";
      if (build.commit_url) a.href = build.commit_url;
    });
    setText("[data-build='message']", build.message || "");

    const deployed = $("[data-build='deployed_at']");
    if (deployed && build.deployed_at) {
      const date = new Date(build.deployed_at);
      deployed.textContent = timeAgo(date);
      deployed.title = date.toLocaleString();
    }

    const runLink = $("[data-build='run_link']");
    if (runLink) {
      runLink.textContent = build.run_number ? "Pipeline #" + build.run_number : "Local build";
      if (build.run_url) runLink.href = build.run_url;
    }
    if (build.duration_seconds) setText("[data-build='duration']", "in " + formatDuration(build.duration_seconds));

    const passed = build.checks || {};
    $$(".checks li").forEach((li, i) => {
      if (passed[li.dataset.check] !== "passed") return;
      window.setTimeout(() => li.classList.add("passed"), reduceMotion ? 0 : 300 + i * 180);
    });
  }

  function renderStatus(status) {
    const checks = (status && status.checks) || [];
    const pulse = $(".pulse");
    if (!checks.length) {
      setText("[data-status='uptime']", "First check pending");
      if (pulse) pulse.dataset.state = "up";
      return;
    }
    const ok = checks.filter((c) => c.ok).length;
    const pct = (ok / checks.length) * 100;
    setText("[data-status='uptime']", (pct === 100 ? "100" : pct.toFixed(2)) + "%");
    const days = Math.max(1, Math.round((Date.now() - new Date(checks[0].at).getTime()) / 86400000));
    setText("[data-status='window']", "over " + checks.length + " checks, " + days + (days === 1 ? " day" : " days"));
    if (pulse) pulse.dataset.state = checks[checks.length - 1].ok ? "up" : "down";

    const bars = $("[data-status='bars']");
    if (!bars) return;
    const recent = checks.slice(-40);
    const frag = document.createDocumentFragment();
    for (let i = recent.length; i < 40; i++) frag.appendChild(document.createElement("span"));
    recent.forEach((c) => {
      const s = document.createElement("span");
      s.dataset.ok = String(Boolean(c.ok));
      s.title = new Date(c.at).toLocaleString() + (c.ok ? ", up in " + c.ms + " ms" : ", failed");
      frag.appendChild(s);
    });
    bars.replaceChildren(frag);
    bars.setAttribute("aria-label", "Last " + recent.length + " health checks, " + ok + " of " + checks.length + " passed overall");
  }

  function renderVisit() {
    const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    if (!nav || !nav.responseStart) { setText("[data-live='ttfb']", "measured on your next visit"); return; }
    setText("[data-live='ttfb']", "first byte in " + Math.round(nav.responseStart - nav.startTime) + " ms");
  }

  getJSON(dataRoot + "data/build.json").then(renderBuild).catch(() => {
    setText("[data-build='deployed_at']", "local preview");
    setText("[data-build='run_link']", "No pipeline data yet");
  });
  getJSON(dataRoot + "data/status.json").then(renderStatus).catch(() => renderStatus(null));
  if (document.readyState === "complete") renderVisit();
  else window.addEventListener("load", () => window.setTimeout(renderVisit, 0));

  // ---------- greeting ----------

  const greetEl = $("[data-greeting]");
  if (greetEl) {
    const hour = new Date().getHours();
    const part = hour >= 5 && hour < 12 ? "morning" : hour < 17 && hour >= 12 ? "afternoon" : hour >= 17 && hour < 22 ? "evening" : "night";
    let mode = null;
    try { mode = window.sessionStorage.getItem("greeting-mode"); } catch (e) { /* ignore */ }
    if (!mode) {
      mode = load("seen") ? "again" : "first";
      try { window.sessionStorage.setItem("greeting-mode", mode); } catch (e) { /* ignore */ }
    }
    save("seen", "1");
    greetEl.textContent = greetEl.dataset[mode].replace("{greeting}", greetEl.dataset[part]);
    greetEl.classList.add("shown");
  }

  // ---------- deploy playground ----------

  const sim = $("[data-sim]");
  if (sim) setupSimulator(sim);

  function setupSimulator(box) {
    const runBtn = $("[data-sim-run]", box);
    const log = $("[data-sim-log]", box);
    const stages = new Map($$("[data-stage]", box).map((li) => [li.dataset.stage, li]));
    const rateEl = $("[data-sim-rate]", box);
    const line = $("[data-sim-line]", box);
    const result = $("[data-sim-result]", box);
    const THRESHOLD = 2; // percent; y = 60 on the chart
    let points = [];
    let started = 0;
    let running = false;

    const sha = () => Math.random().toString(16).slice(2, 9);

    function say(text, tone) {
      if (log.querySelector(".log-idle")) log.replaceChildren();
      const p = document.createElement("p");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = "+" + ((performance.now() - started) / 1000).toFixed(1).padStart(4, " ") + "s  ";
      const msg = document.createElement("span");
      if (tone) msg.className = tone;
      msg.textContent = text;
      p.append(t, msg);
      log.appendChild(p);
      log.scrollTop = log.scrollHeight;
    }

    function setStage(id, state) { const li = stages.get(id); if (li) li.dataset.state = state; }

    function plot(rate) {
      points.push(rate);
      if (points.length > 40) points.shift();
      const step = 300 / 39;
      const offset = 40 - points.length;
      line.setAttribute("points", points.map((v, i) => {
        const y = 120 - Math.min(v, 4) * 30; // 0% at bottom, 4% at top, 2% at middle
        return ((offset + i) * step).toFixed(1) + "," + y.toFixed(1);
      }).join(" "));
      rateEl.textContent = rate.toFixed(1) + "%";
      rateEl.dataset.high = String(rate > THRESHOLD);
    }

    async function watch(seconds, rateFn) {
      // Like a real canary analysis, one noisy sample doesn't fail it; three in a row does.
      const ticks = Math.round(seconds * 5);
      let breaches = 0;
      for (let i = 0; i < ticks; i++) {
        const rate = rateFn(i, ticks);
        plot(rate);
        breaches = rate > THRESHOLD ? breaches + 1 : 0;
        if (breaches >= 3) return false;
        await wait(200);
      }
      return true;
    }

    const calm = () => 0.2 + Math.random() * 0.35;

    function reset() {
      stages.forEach((li) => delete li.dataset.state);
      log.replaceChildren();
      points = [];
      line.setAttribute("points", "");
      rateEl.textContent = "0.0%";
      rateEl.dataset.high = "false";
      result.textContent = "";
      delete result.dataset.tone;
    }

    function finish(text, tone) {
      result.textContent = text;
      result.dataset.tone = tone;
      runBtn.disabled = false;
      runBtn.textContent = "Deploy again";
      running = false;
    }

    async function run() {
      if (running) return;
      running = true;
      runBtn.disabled = true;
      runBtn.textContent = "Deploying";
      reset();
      started = performance.now();
      const scenario = ($("input[name='scenario']:checked", box) || {}).value || "clean";
      const commit = sha();

      setStage("commit", "running");
      say("push to main: payments-api@" + commit, "info");
      await wait(500);
      setStage("commit", "passed");

      setStage("build", "running");
      say("building image payments-api:" + commit);
      await wait(900);
      say("image built, 142 MB, layers cached 9/11", "ok");
      setStage("build", "passed");

      setStage("test", "running");
      say("running 318 unit and integration tests");
      await wait(900);
      say("318 passed", "ok");
      setStage("test", "passed");

      setStage("scan", "running");
      say("trivy image scan, severity HIGH,CRITICAL");
      await wait(1000);
      if (scenario === "vuln") {
        say("1 CRITICAL: openssl in base image, fixed version available", "bad");
        say("policy: block on CRITICAL with a fix. pipeline stopped", "bad");
        setStage("scan", "failed");
        ["c10", "c50", "full"].forEach((s) => setStage(s, "skipped"));
        finish("Blocked at the security scan. The vulnerable image never reached a single user.", "warn");
        return;
      }
      say("0 HIGH, 0 CRITICAL", "ok");
      setStage("scan", "passed");

      setStage("c10", "running");
      say("argo rollouts: sending 10% of traffic to the new version");
      say("watching error rate against the 2% threshold");
      const firstOk = await watch(3, scenario === "canary"
        ? (i) => (i < 5 ? calm() : 0.4 + (i - 5) * 0.55 + Math.random() * 0.2)
        : calm);
      if (!firstOk) {
        say("error rate " + points[points.length - 1].toFixed(1) + "% at 10% traffic. analysis failed", "bad");
        setStage("c10", "failed");
        say("rolling back to the previous version", "warn");
        await wait(700);
        ["c50", "full"].forEach((s) => setStage(s, "skipped"));
        await watch(1.6, calm);
        setStage("c10", "rolled");
        say("rollback complete, error rate back to normal", "ok");
        const secs = ((performance.now() - started) / 1000).toFixed(0);
        finish("Rolled back on its own in " + secs + " seconds. 90% of users never saw the bad version.", "warn");
        return;
      }
      setStage("c10", "passed");
      say("canary healthy at 10%", "ok");

      setStage("c50", "running");
      say("promoting to 50% of traffic");
      await watch(2, calm);
      setStage("c50", "passed");
      say("canary healthy at 50%", "ok");

      setStage("full", "running");
      say("promoting to 100%, scaling down the old version");
      await wait(800);
      setStage("full", "passed");
      say("rollout complete", "ok");
      const secs = ((performance.now() - started) / 1000).toFixed(0);
      finish("Shipped to everyone in " + secs + " seconds. Nobody noticed, which is the point.", "ok");
    }

    runBtn.addEventListener("click", run);
  }

  // ---------- skill finder ----------

  const siteRoot = body.dataset.root || "./";
  const PLACES = {
    ci: { label: "Faster path to production", href: "work/faster-releases/" },
    deploy: { label: "Releases nobody notices", href: "work/zero-downtime-releases/" },
    gpu: { label: "GPU platform for ML", href: "work/gpu-platform-for-ml/" },
    obs: { label: "Seeing problems first", href: "work/observability/" },
    sec: { label: "Security in the pipeline", href: "work/security-in-the-pipeline/" },
    site: { label: "this website", href: "work/this-website/" },
    amistad: { label: "Amistad Technologies", href: "experience/#amistad" },
    taal: { label: "Taal Tech", href: "experience/#taal" },
    ignitarium: { label: "Ignitarium", href: "experience/#ignitarium" }
  };
  const chips = $$("[data-skills] button");
  const answer = $("[data-skill-answer]");

  chips.forEach((chip) => {
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => {
      const wasOn = chip.getAttribute("aria-pressed") === "true";
      chips.forEach((c) => c.setAttribute("aria-pressed", "false"));
      answer.replaceChildren();
      if (wasOn) { answer.textContent = "Pick a tool above."; return; }
      chip.setAttribute("aria-pressed", "true");

      const name = chip.dataset.skill;
      const used = (chip.dataset.used || "").split(/\s+/).filter((k) => PLACES[k]);
      if (!used.length) {
        answer.textContent = name + " is part of my everyday toolkit. Ask me about it.";
        return;
      }
      answer.append("Where I’ve used " + name + ": ");
      used.forEach((key, i) => {
        if (i > 0) answer.append(i === used.length - 1 ? " and " : ", ");
        const a = document.createElement("a");
        a.href = siteRoot + PLACES[key].href;
        a.textContent = PLACES[key].label;
        answer.append(a);
      });
      answer.append(".");
    });
  });

  // ---------- projects from GitHub ----------

  const repoBox = $("[data-repos]");
  function renderRepos(list) {
    if (!repoBox || !Array.isArray(list)) return;
    const shown = list
      .filter((r) => !r.fork && !r.archived && r.name !== repo && r.name.toLowerCase() !== user.toLowerCase())
      .slice(0, 6);
    if (!shown.length) return;
    const frag = document.createDocumentFragment();
    shown.forEach((r) => {
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
        .forEach((t) => { const span = document.createElement("span"); span.textContent = t; meta.appendChild(span); });
      card.appendChild(meta);
      frag.appendChild(card);
    });
    repoBox.replaceChildren(frag);
  }

  // A snapshot from the build shows instantly, then the live API refreshes it.
  getJSON(dataRoot + "data/repos.json").then(renderRepos).catch(() => {}).then(() => {
    if (!user || user.indexOf("{{") === 0) return;
    return getJSON("https://api.github.com/users/" + encodeURIComponent(user) + "/repos?sort=pushed&per_page=30")
      .then(renderRepos)
      .catch(() => {});
  });

  // ---------- visitor stats (GoatCounter, no cookies) ----------
  {

    const isLocal = /^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname);
    const track = (name, title) => {
      if (isLocal) return;
      const send = () => {
        if (window.goatcounter && window.goatcounter.count) {
          window.goatcounter.count({ path: name, title: title || name, event: true });
          return true;
        }
        return false;
      };
      if (!send()) window.setTimeout(send, 1500);
    };

    // Clicks on the résumé, email and profile links
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a, button");
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (/resume\/.*\.pdf/i.test(href)) track("resume-opened", "Résumé opened");
      else if (/mail\.google\.com|^mailto:/i.test(href) || a.hasAttribute("data-copy")) track("email-click", "Email clicked");
      else if (/linkedin\.com/i.test(href)) track("linkedin-click", "LinkedIn clicked");
      else if (/github\.com/i.test(href)) track("github-click", "GitHub clicked");
    });

    // How far down each page people actually read
    const marks = [25, 50, 75, 100];
    const hit = {};
    const pagePath = location.pathname.replace(/index\.html$/, "");
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max <= 0) return;
      const pct = (window.scrollY / max) * 100;
      marks.forEach((m) => {
        if (pct >= m - 1 && !hit[m]) {
          hit[m] = true;
          track("scroll-" + m + pagePath, "Scrolled " + m + "% on " + pagePath);
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // ---------- copy email ----------

  $$("[data-copy]").forEach((btn) => {
    const label = btn.textContent;
    btn.addEventListener("click", () => {
      const text = btn.dataset.copy;
      const done = () => {
        btn.textContent = "Copied";
        btn.dataset.copied = "true";
        window.setTimeout(() => { btn.textContent = label; btn.dataset.copied = "false"; }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => { window.location.href = "mailto:" + text; });
      } else {
        window.location.href = "mailto:" + text;
      }
    });
  });
})();
