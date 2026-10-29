/* Relay Crosscheck web app. The analysis lives in crosscheck.js (built from src/); this file is only the interface. */
(function () {
  "use strict";
  const R = window.RelayCrosscheck;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const fmtNum = n => Number(n || 0).toLocaleString("en-US");

  /* ---------- tiny DOM builder: every string goes in as text, never as HTML ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  }
  const link = (href, text) => h("a", { href, target: "_blank", rel: "noopener" }, text || href);
  const put = (box, ...nodes) => {
    box.replaceChildren(...nodes.flat().filter(Boolean));
    box.classList.remove("reveal"); void box.offsetWidth; box.classList.add("reveal");
  };
  const spinner = text => h("div", { class: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), h("span", {}, text));
  const alertBox = (kind, title, ...body) => h("div", { class: "alert " + (kind || ""), role: kind === "err" ? "alert" : null }, title ? h("b", {}, title) : null, ...body);

  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }
  async function copy(text, what) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = h("textarea", { style: "position:fixed;opacity:0" }); ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* nothing more to try */ } ta.remove();
    }
    toast((what || "Text") + " copied");
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || "text/plain" }));
    const a = h("a", { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  /* ---------- theme ---------- */
  const effectiveTheme = () => document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  $("#theme").addEventListener("click", () => {
    const next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next; store.set("rc-theme", next);
    const f = $(".report-frame"); if (f) themeFrame(f);
  });

  /* ---------- tabs and shareable links (#ticket=0x…, #scan=owner/repo, #health=pumpfun) ---------- */
  const TABS = ["ticket", "scan", "health"];
  const HINTS = {
    ticket: "Looks up one transfer on Relay and drafts the replies.",
    scan: "Reads a public repository and lists what Relay's changes will break.",
    health: "Drop an integrator's export below, or try Pump.fun's published data.",
  };
  const PLACEHOLDER = { ticket: "0x… request ID, transaction hash or wallet", scan: "owner/repo or a github.com link", health: "0x… or owner/repo" };
  let currentTab = "ticket";
  function moveSlider() {
    const b = $("#tab-" + currentTab), slider = $(".mode-slider");
    if (!b || !slider) return;
    slider.style.setProperty("--x", b.offsetLeft + "px");
    slider.style.setProperty("--w", b.offsetWidth + "px");
  }
  function selectTab(name, focus) {
    currentTab = name;
    for (const t of TABS) {
      const b = $("#tab-" + t), p = $("#panel-" + t), on = t === name;
      b.setAttribute("aria-selected", on); b.tabIndex = on ? 0 : -1; p.hidden = !on;
    }
    $("#hint").textContent = HINTS[name];
    $("#q").placeholder = PLACEHOLDER[name];
    moveSlider();
    if (focus) $("#tab-" + name).focus();
  }
  window.addEventListener("resize", moveSlider);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveSlider);

  // One input for everything: what you paste decides the tool.
  const looksLikeRepo = v => /github\.com\//i.test(v) || /^[\w.-]+\/[\w.-]+(\/|$)/.test(v);
  function detect(raw) {
    const v = String(raw || "").trim();
    if (R.engine.isHash(v) || R.engine.isAddr(v)) return "ticket";
    if (looksLikeRepo(v)) return "scan";
    return null;
  }
  $("#q").addEventListener("input", () => { const t = detect($("#q").value); if (t && t !== currentTab) { selectTab(t); setHash(t); } });
  $("#ask").addEventListener("submit", e => {
    e.preventDefault();
    const v = $("#q").value.trim();
    const t = detect(v) || (v.startsWith("0x") ? "ticket" : currentTab);
    if (t !== currentTab) selectTab(t);
    if (t === "ticket") runTicket(v);
    else if (t === "scan") runScanGithub(v);
    else put($("#health-out"), alertBox("", "Integrator health works from an export, not a pasted value.", h("p", {}, "Drop a CSV or JSON file in the box above, or try Pump.fun's published data.")));
  });
  $$(".modes button").forEach(b => {
    b.addEventListener("click", () => { selectTab(b.dataset.tab); setHash(b.dataset.tab); });
    b.addEventListener("keydown", e => {
      const i = TABS.indexOf(b.dataset.tab);
      const j = e.key === "ArrowRight" ? (i + 1) % 3 : e.key === "ArrowLeft" ? (i + 2) % 3 : e.key === "Home" ? 0 : e.key === "End" ? 2 : -1;
      if (j < 0) return; e.preventDefault(); selectTab(TABS[j], true); setHash(TABS[j]);
    });
  });
  function setHash(tab, value) {
    const hash = "#" + tab + (value ? "=" + encodeURIComponent(value) : "");
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }
  const shareLink = () => copy(location.href, "Link");
  function readHash() {
    const m = location.hash.match(/^#(ticket|scan|health)(?:=(.*))?$/);
    if (!m) return;
    const tab = m[1], value = m[2] ? decodeURIComponent(m[2]) : "";
    selectTab(tab);
    if (!value) return;
    if (tab === "ticket") { $("#q").value = value; runTicket(value); }
    if (tab === "scan") { if (value === "example") runScanExample(); else { $("#q").value = value; runScanGithub(value); } }
    if (tab === "health" && value === "pumpfun") runHealthExample();
  }

  /* =====================================================================
     The route drawing: shows how a transfer went, from chain to chain
     ===================================================================== */
  let routeRaf = 0;
  const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const MARKS = { check: "M305 150 l5 5 l9 -10", cross: "M306.5 144.5 l11 11 m0 -11 l-11 11" };
  function playRoute({ from, to, outcome, status, detail }) {
    const path = $("#rt-trail"), dot = $("#rt-dot"); if (!path) return;
    const len = path.getTotalLength();
    $("#rt-from-label").textContent = from; $("#rt-to-label").textContent = to;
    $("#rt-status").textContent = ""; $("#rt-detail").textContent = outcome === "waiting" ? "" : "Following the transfer…";
    const fromN = $("#rt-from"), toN = $("#rt-to"), mark = $("#rt-mark");
    fromN.setAttribute("class", "rt-node on"); toN.setAttribute("class", "rt-node"); mark.setAttribute("d", "");
    dot.setAttribute("class", "rt-dot"); dot.style.opacity = 1;
    cancelAnimationFrame(routeRaf);
    // Each leg moves the dot between two points on the curve (0 = origin chain, 1 = destination chain).
    const legs = { delivered: [[0, 1, 1300]], refund: [[0, .62, 800], [.62, 0, 900]], failed: [[0, .55, 900]], moving: [[0, .5, 900]], waiting: [] }[outcome] || [];
    let reach = 0;
    const place = t => {
      const p = path.getPointAtLength(len * t);
      dot.setAttribute("cx", p.x.toFixed(1)); dot.setAttribute("cy", p.y.toFixed(1));
      reach = Math.max(reach, t);
      path.style.strokeDasharray = (len * reach).toFixed(1) + " " + len.toFixed(1);
    };
    const finish = () => {
      $("#rt-status").textContent = status; $("#rt-detail").textContent = detail;
      if (outcome === "delivered") { toN.setAttribute("class", "rt-node ok"); mark.setAttribute("d", MARKS.check); fromN.setAttribute("class", "rt-node ok"); dot.style.opacity = 0; }
      if (outcome === "refund") { fromN.setAttribute("class", "rt-node warn"); dot.setAttribute("class", "rt-dot warn"); }
      if (outcome === "failed") { dot.setAttribute("class", "rt-dot bad"); toN.setAttribute("class", "rt-node bad"); mark.setAttribute("d", MARKS.cross); }
      if (outcome === "moving" || outcome === "waiting") dot.setAttribute("class", "rt-dot wait");
    };
    place(0); reach = 0; path.style.strokeDasharray = "0 " + len;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !legs.length) {
      for (const [, b] of legs) place(b);
      if (legs.length) reach = Math.max(...legs.map(l => Math.max(l[0], l[1]))), place(legs[legs.length - 1][1]);
      return finish();
    }
    let i = 0, start = 0;
    const step = now => {
      if (!start) start = now;
      const [a, b, ms] = legs[i], k = Math.min(1, (now - start) / ms);
      place(a + (b - a) * easeInOut(k));
      if (k < 1) { routeRaf = requestAnimationFrame(step); return; }
      if (++i < legs.length) { start = 0; routeRaf = requestAnimationFrame(step); return; }
      finish();
    };
    routeRaf = requestAnimationFrame(step);
  }
  const OUTCOME = { success: "delivered", refund: "refund", failure: "failed", waiting: "waiting" };
  let routeShown = false;
  function routeFor(n, d) {
    routeShown = true;
    playRoute({ from: R.engine.chainName(n.originChainId), to: R.engine.chainName(n.destChainId), outcome: OUTCOME[n.status] || "moving", status: d.headline, detail: d.summary });
  }

  /* =====================================================================
     Ticket
     ===================================================================== */
  const SEV_TEXT = { ok: "All good", info: "In progress", warn: "Needs a look", bad: "Action needed" };
  const TONE_ICON = { ok: "✓", warn: "!", bad: "✕", info: "i" };
  let ticketRun = 0;

  $$("[data-ticket]").forEach(b => b.addEventListener("click", () => { $("#q").value = b.dataset.ticket; selectTab("ticket"); runTicket(b.dataset.ticket); }));

  async function runTicket(raw) {
    const q = String(raw || "").trim();
    const out = $("#ticket-out"), btn = $("#go"), run = ++ticketRun;
    if (!R.engine.isHash(q) && !R.engine.isAddr(q)) {
      put(out, alertBox("err", "That doesn't look like something Relay can look up.", "Paste a request ID or transaction hash (0x followed by 64 characters), or a wallet address (0x followed by 40)."));
      return;
    }
    setHash("ticket", q);
    btn.disabled = true;
    put(out, spinner("Asking Relay's API…"));
    try {
      const found = await R.ticket.lookup(q, { apiKey: $("#ticket-key").value.trim() || undefined });
      if (run !== ticketRun) return;
      const results = R.ticket.diagnoseAll(found);
      const webNote = n => n.replace(/\(use --api-key\)/g, "(add an API key under \"Use a Relay API key\")").replace(/Pass --api-key to/g, "Add an API key to");
      const notes = found.notes.length ? h("ul", { class: "notes" }, found.notes.map(n => h("li", {}, webNote(n))), h("li", {}, "Looked up via " + found.source + ".")) : h("ul", { class: "notes" }, h("li", {}, "Looked up via " + found.source + "."));
      if (!results.length) { put(out, alertBox("", "No Relay request found for this value.", notes)); return; }
      routeFor(results[0].request, results[0].diagnosis);
      if (results.length === 1) { put(out, renderDiagnosis(results[0].request, results[0].diagnosis), notes); return; }
      put(out,
        h("p", { class: "muted" }, fmtNum(results.length) + " requests found for this wallet, newest first. Open one to see the details and replies."),
        results.map((r, i) => h("details", { class: "multi", open: i === 0 },
          h("summary", {}, h("span", { class: "pill " + r.diagnosis.sev }, SEV_TEXT[r.diagnosis.sev] || r.diagnosis.sev), h("b", {}, r.diagnosis.headline), h("span", { class: "muted mono" }, R.engine.short(r.request.id)), h("span", { class: "muted" }, routeShort(r.request))),
          h("div", { class: "inner" }, renderDiagnosis(r.request, r.diagnosis, true)))),
        notes);
    } catch (e) {
      if (run !== ticketRun) return;
      const offline = e && (e.status === 0 || e.name === "TypeError");
      put(out, alertBox("err", offline ? "Couldn't reach Relay's API." : "The lookup failed.", e.message || String(e), offline ? h("p", {}, "Check your connection, or try again in a minute. Some networks block api.relay.link.") : null));
    } finally { if (run === ticketRun) btn.disabled = false; }
  }

  const routeShort = n => R.engine.chainName(n.originChainId) + " → " + R.engine.chainName(n.destChainId);

  function renderDiagnosis(n, d, compact) {
    const E = R.engine;
    const head = compact ? null : h("div", { class: "result-head" }, h("span", { class: "pill " + d.sev }, SEV_TEXT[d.sev] || d.sev), h("h2", {}, d.headline));
    const route = h("div", { class: "route" },
      h("span", {}, routeShort(n)),
      n.id ? h("span", {}, "Request ", h("button", { class: "chip mono", type: "button", title: "Copy request ID", onclick: () => copy(n.id, "Request ID") }, E.short(n.id))) : null,
      n.id ? link(E.relayTxUrl(n.id), "Open on relay.link") : null,
      h("span", {}, "Source: " + n.source));
    const findings = h("ul", { class: "findings" }, d.findings.map(f => h("li", {}, h("span", { class: "ic " + f.tone, "aria-hidden": "true" }, TONE_ICON[f.tone] || "•"), h("div", {}, h("b", {}, f.label), h("p", {}, f.detail)))));
    const checks = d.checks.length ? h("div", { class: "box" }, h("h3", {}, "Next checks"), h("ol", { class: "checks" }, d.checks.map(c => h("li", {}, c)))) : null;
    const tl = h("ul", { class: "timeline" }, d.timeline.map(t => h("li", {},
      h("b", {}, t.label), " ", h("span", { class: "t" }, t.ts ? E.fmtUtc(t.ts) : ""),
      t.hash ? h("div", {}, t.url ? link(t.url, E.short(t.hash) + " on " + E.explorerName(t.chainId)) : h("span", { class: "mono" }, E.short(t.hash))) : null)));
    let money = null;
    if (d.money) {
      const m = d.money, rows = [];
      if (m.amountIn) rows.push(["Sent", E.fmtAmt(m.amountIn) + (m.amountIn.usd != null ? " (" + E.fmtUsd(m.amountIn.usd) + ")" : "")]);
      if (m.amountOut) rows.push(["Received", E.fmtAmt(m.amountOut) + (m.amountOut.usd != null ? " (" + E.fmtUsd(m.amountOut.usd) + ")" : "")]);
      if (m.gasTopup) rows.push(["Gas top-up", E.fmtAmt(m.gasTopup)]);
      if (m.slippagePct != null) rows.push(["Slippage allowed", m.slippagePct + "%"]);
      if (rows.length) money = h("div", { class: "box" }, h("h3", {}, "Amounts"), h("dl", { class: "money" }, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])));
    }
    return h("div", {},
      head, h("p", { class: "summary" }, d.summary), route,
      h("div", { class: "cols" },
        h("div", {}, h("div", { class: "box" }, h("h3", {}, "Findings"), findings), checks),
        h("div", {}, h("div", { class: "box" }, h("h3", {}, "Timeline"), tl), money)),
      drafts([["Customer reply", d.userReply], ["Developer reply", d.devReply], d.escalation ? ["Escalation note", d.escalation] : null].filter(Boolean)));
  }

  let draftSeq = 0;
  function drafts(list) {
    const id = "d" + (++draftSeq);
    const tabs = list.map(([label], i) => h("button", { type: "button", role: "tab", id: id + "-t" + i, "aria-selected": i === 0 ? "true" : "false", "aria-controls": id + "-p" + i, tabindex: i === 0 ? null : "-1" }, label));
    const panes = list.map(([label, text], i) => h("div", { class: "draft", role: "tabpanel", id: id + "-p" + i, "aria-labelledby": id + "-t" + i, hidden: i !== 0 },
      h("pre", {}, text),
      h("div", { class: "actions" }, h("button", { type: "button", class: "secondary", onclick: () => copy(text, label) }, "Copy"))));
    tabs.forEach((t, i) => t.addEventListener("click", () => {
      tabs.forEach((x, j) => { x.setAttribute("aria-selected", i === j); x.tabIndex = i === j ? 0 : -1; panes[j].hidden = i !== j; });
    }));
    return h("div", { class: "drafts" }, h("div", { class: "dtabs", role: "tablist", "aria-label": "Draft replies" }, tabs), panes);
  }

  /* =====================================================================
     Scan
     ===================================================================== */
  const GROUPS = [["breaking", "Breaks now"], ["deadline", "Breaks on a set date"], ["warning", "Should fix"], ["info", "Worth knowing"]];
  const MAX_FILES = 2500;
  let scanRun = 0;

  $$("[data-scan]").forEach(b => b.addEventListener("click", () => { $("#q").value = b.dataset.scan; selectTab("scan"); runScanGithub(b.dataset.scan); }));
  $$("[data-scan-example]").forEach(b => b.addEventListener("click", () => { $("#q").value = ""; selectTab("scan"); runScanExample(); }));
  const includeTests = () => $("#scan-tests").checked;

  function parseRepo(input) {
    let s = String(input || "").trim().replace(/\.git$/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
    s = s.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "");
    const parts = s.split("/").filter(Boolean);
    if (parts.length < 2 || !/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) return null;
    const rest = (parts[2] === "tree" || parts[2] === "blob") ? parts.slice(3) : [];
    return { owner: parts[0], repo: parts[1], rest };
  }

  class GhError extends Error { constructor(msg, status) { super(msg); this.status = status; } }
  async function gh(path) {
    let res;
    try { res = await fetch("https://api.github.com" + path, { headers: { accept: "application/vnd.github+json" } }); }
    catch { throw new GhError("Couldn't reach GitHub. Check your connection.", 0); }
    if (res.ok) return res.json();
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
      const mins = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) : null;
      throw new GhError("GitHub allows about 30 scans an hour from one connection without signing in, and that's used up" + (mins ? ". Try again in " + mins + " minute" + (mins > 1 ? "s" : "") : "") + ", or scan a folder from your computer instead.", 429);
    }
    throw new GhError(res.status === 404 ? "GitHub says that repository or branch doesn't exist, or it's private. Only public repositories can be scanned by link." : "GitHub answered " + res.status + ".", res.status);
  }

  async function githubFiles(target, onProgress) {
    const info = await gh(`/repos/${target.owner}/${target.repo}`);
    // A link like /tree/feature/x/src is ambiguous: try the shortest branch name first.
    let ref = info.default_branch, sub = "", tree = null;
    const attempts = target.rest.length ? target.rest.map((_, i) => [target.rest.slice(0, i + 1).join("/"), target.rest.slice(i + 1).join("/")]) : [[info.default_branch, ""]];
    for (const [r, s] of attempts) {
      try { tree = await gh(`/repos/${target.owner}/${target.repo}/git/trees/${encodeURIComponent(r)}?recursive=1`); ref = r; sub = s; break; }
      catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
    }
    if (!tree) throw new GhError("Couldn't find that branch or folder in " + info.full_name + ".", 404);
    const prefix = sub ? sub.replace(/\/$/, "") + "/" : "";
    let blobs = tree.tree.filter(t => t.type === "blob" && (!prefix || t.path.startsWith(prefix) || t.path === sub) && R.scan.wantPath(t.path, { includeTests: includeTests(), size: t.size || 0 }));
    const total = blobs.length, capped = total > MAX_FILES;
    if (capped) blobs = blobs.slice(0, MAX_FILES);
    const files = []; let done = 0, failed = 0, next = 0;
    const rawUrl = p => `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${encodeURIComponent(ref).replace(/%2F/g, "/")}/${p.split("/").map(encodeURIComponent).join("/")}`;
    async function worker() {
      while (next < blobs.length) {
        const b = blobs[next++];
        try {
          const r = await fetch(rawUrl(b.path));
          if (!r.ok) throw new Error(r.status);
          const f = R.scan.prepare(b.path, await r.text());
          if (f) files.push(f);
        } catch { failed++; }
        onProgress(++done, blobs.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(12, blobs.length) }, worker));
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, failed, total, capped, ref, sub, name: info.full_name, truncatedTree: !!tree.truncated,
      lineUrl: (p, line) => `https://github.com/${info.full_name}/blob/${encodeURIComponent(ref).replace(/%2F/g, "/")}/${p.split("/").map(encodeURIComponent).join("/")}#L${line}` };
  }

  async function runScanGithub(input) {
    const out = $("#scan-out"), btn = $("#go"), run = ++scanRun;
    const target = parseRepo(input);
    if (!target) { put(out, alertBox("err", "That isn't a GitHub repository link.", "Use owner/repo (for example relayprotocol/relay-kit) or a github.com link to a repository or one of its folders.")); return; }
    setHash("scan", target.owner + "/" + target.repo + (target.rest.length ? "/tree/" + target.rest.join("/") : ""));
    btn.disabled = true;
    const label = h("span", {}, "Reading the file list from GitHub…"), bar = h("i");
    put(out, h("div", { class: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), label), h("div", { class: "progress", role: "progressbar", "aria-label": "Files read" }, bar));
    try {
      const got = await githubFiles(target, (d, n) => { if (run !== scanRun) return; label.textContent = `Reading files: ${fmtNum(d)} of ${fmtNum(n)}`; bar.style.width = (100 * d / n).toFixed(1) + "%"; });
      if (run !== scanRun) return;
      const result = R.scan.scanFiles(got.files, { root: got.name });
      const where = got.name + (got.sub ? "/" + got.sub : "") + " @ " + got.ref;
      const notes = [];
      if (got.capped) notes.push(`This repository has ${fmtNum(got.total)} source files; the first ${fmtNum(MAX_FILES)} were scanned. Scan a folder link to narrow it down.`);
      if (got.truncatedTree) notes.push("GitHub returned a partial file list because the repository is very large. Scan a folder link to cover the rest.");
      if (got.failed) notes.push(`${fmtNum(got.failed)} file${got.failed > 1 ? "s" : ""} couldn't be downloaded and were skipped.`);
      renderScan(result, { where, lineUrl: got.lineUrl, notes, shareable: true });
    } catch (e) {
      if (run !== scanRun) return;
      put(out, alertBox("err", "The scan didn't run.", e.message || String(e)));
    } finally { if (run === scanRun) btn.disabled = false; }
  }

  function runScanExample() {
    ++scanRun;
    setHash("scan", "example");
    const files = R.examples.legacyApp.filter(f => R.scan.wantPath(f.path, { includeTests: true })).map(f => R.scan.prepare(f.path, f.text)).filter(Boolean);
    renderScan(R.scan.scanFiles(files, { root: "example" }), { where: "an example integration written the way many were in early 2026", notes: ["This example is built into the page. It's the same code the project's tests check against."], shareable: true });
  }

  async function scanLocal(entries, folderName) {
    const out = $("#scan-out"), run = ++scanRun;
    setHash("scan");
    const keep = entries.filter(e => R.scan.wantPath(e.path, { includeTests: includeTests(), size: e.file.size }));
    put(out, spinner(`Reading ${fmtNum(keep.length)} files…`));
    const files = [];
    for (const e of keep.slice(0, 5000)) { const f = R.scan.prepare(e.path, await e.file.text()); if (f) files.push(f); }
    if (run !== scanRun) return;
    const notes = keep.length > 5000 ? ["Only the first 5,000 source files were scanned."] : [];
    if (!keep.length) notes.push("No source files were found. The scanner reads JavaScript, TypeScript, Python, Go, Rust, Solidity and similar files, plus package.json.");
    renderScan(R.scan.scanFiles(files, { root: folderName }), { where: "the folder " + (folderName || "you chose"), notes, shareable: false });
  }

  // Folder picker and drag-and-drop (folders are walked with the File System entries API).
  const scanDrop = $("#scan-drop"), scanInput = $("#scan-folder");
  scanDrop.addEventListener("click", () => scanInput.click());
  scanDrop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); scanInput.click(); } });
  scanInput.addEventListener("change", () => {
    const list = Array.from(scanInput.files || []);
    if (!list.length) return;
    const top = (list[0].webkitRelativePath || "").split("/")[0];
    scanLocal(list.map(f => ({ path: (f.webkitRelativePath || f.name).split("/").slice(top ? 1 : 0).join("/"), file: f })), top);
    scanInput.value = "";
  });
  dropZone(scanDrop, async dt => {
    const items = Array.from(dt.items || []).map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!items.length) return;
    const entries = [];
    const walk = (entry, prefix) => new Promise(resolve => {
      if (entry.isFile) entry.file(file => { entries.push({ path: prefix + entry.name, file }); resolve(); }, () => resolve());
      else if (entry.isDirectory) {
        if (R.scan.wantPath(prefix + entry.name + "/x.js", { includeTests: true }) === false && prefix) return resolve(); // skipped folders like node_modules
        const reader = entry.createReader(), all = [];
        const more = () => reader.readEntries(async batch => {
          if (batch.length) { all.push(...batch); more(); }
          else { for (const e of all) await walk(e, prefix + entry.name + "/"); resolve(); }
        }, () => resolve());
        more();
      } else resolve();
    });
    const single = items.length === 1 && items[0].isDirectory;
    put($("#scan-out"), spinner("Collecting files…"));
    for (const it of items) await walk(it, "");
    const name = single ? items[0].name : "";
    scanLocal(entries.map(e => ({ ...e, path: single ? e.path.split("/").slice(1).join("/") : e.path })), name);
  });

  function daysUntil(day) { return Math.ceil((Date.parse(day + "T00:00:00Z") - Date.now()) / 864e5); }

  function renderScan(result, { where, lineUrl, notes = [], shareable }) {
    const out = $("#scan-out");
    const c = result.counts;
    const counts = h("div", { class: "counts" }, GROUPS.map(([k, label]) => h("div", { class: "count " + k }, h("b", {}, c[k]), h("span", {}, label))));
    const toolbar = h("div", { class: "toolbar" },
      h("div", { class: "left" }, `Scanned ${fmtNum(result.scannedFiles)} files in ${where} against ${R.scan.RULE_COUNT} rules, ${result.today}.`),
      h("div", { class: "right" },
        result.findings.length ? h("button", { type: "button", class: "secondary", onclick: () => copy(scanMarkdown(result, where), "Report") }, "Copy as Markdown") : null,
        result.findings.length ? h("button", { type: "button", class: "secondary", onclick: () => download("relay-crosscheck.sarif", JSON.stringify(R.scan.toSarif(result), null, 2), "application/json") }, "Download SARIF") : null,
        shareable ? h("button", { type: "button", class: "secondary", onclick: shareLink }, "Copy link") : null));
    const body = [];
    if (!result.findings.length) body.push(h("div", { class: "clean" }, h("b", {}, "No problems found."), h("span", { class: "muted" }, "Nothing in this code matches Relay's breaking changes, deprecations or known pitfalls up to " + result.today + ".")));
    for (const [sev, label] of GROUPS) {
      const list = result.findings.filter(f => f.severity === sev);
      if (!list.length) continue;
      body.push(h("h3", { class: "group-title" }, label + " (" + list.length + ")"));
      for (const f of list) body.push(renderFinding(f, lineUrl));
    }
    put(out, counts, toolbar, body, notes.length ? h("ul", { class: "notes" }, notes.map(n => h("li", {}, n))) : null);
  }

  function renderFinding(f, lineUrl) {
    const days = f.deadline ? daysUntil(f.deadline) : null;
    const due = f.deadline ? (days > 0 ? `Deadline ${f.deadline} (in ${days} day${days === 1 ? "" : "s"})` : `Deadline ${f.deadline} has passed`) : null;
    const shown = f.locations.slice(0, 5), hidden = f.locations.slice(5);
    const loc = l => h("li", {},
      lineUrl ? link(lineUrl(l.file, l.line), l.file + ":" + l.line) : h("span", { class: "mono" }, l.file + ":" + l.line),
      l.text ? h("span", { class: "src", title: l.text }, l.text) : null,
      l.detail ? h("span", { class: "muted" }, l.detail) : null);
    return h("article", { class: "finding " + f.severity },
      h("div", { class: "meta" }, h("span", { class: "pill " + f.severity }, { breaking: "Breaks now", deadline: "Deadline", warning: "Should fix", info: "Note" }[f.severity] || f.severity), due ? h("span", {}, due) : null, h("span", { class: "mono" }, f.rule)),
      h("h4", {}, f.title),
      h("p", {}, h("b", {}, "Why it matters: "), f.why),
      h("p", {}, h("b", {}, "Fix: "), f.fix),
      h("p", {}, link(f.docs, "Relay docs for this change")),
      h("ul", { class: "locs" }, shown.map(loc),
        hidden.length || f.total > f.locations.length ? h("li", {}, h("details", {}, h("summary", { class: "muted" }, `${f.total - shown.length} more place${f.total - shown.length === 1 ? "" : "s"}`), h("ul", { class: "locs" }, hidden.map(loc)), f.total > f.locations.length ? h("p", { class: "muted" }, "Only the first " + f.locations.length + " are listed.") : null)) : null));
  }

  function scanMarkdown(result, where) {
    const c = result.counts;
    let md = `## Relay Crosscheck: ${where}\n\nScanned ${result.scannedFiles} files on ${result.today}: ${c.breaking} breaking, ${c.deadline} with a deadline, ${c.warning} warnings, ${c.info} notes.\n`;
    for (const [sev, label] of GROUPS) {
      const list = result.findings.filter(f => f.severity === sev);
      if (!list.length) continue;
      md += `\n### ${label}\n`;
      for (const f of list) {
        md += `\n**${f.title}**${f.deadline ? ` (deadline ${f.deadline})` : ""}\n\n`;
        md += f.locations.slice(0, 5).map(l => `- \`${l.file}:${l.line}\``).join("\n") + (f.total > 5 ? `\n- …and ${f.total - 5} more` : "") + "\n\n";
        md += `Why: ${f.why}\n\nFix: ${f.fix}\n\nDocs: ${f.docs}\n`;
      }
    }
    return md + "\n_Generated with Relay Crosscheck (https://github.com/SwapnilV07/relay-crosscheck)._\n";
  }

  /* =====================================================================
     Health
     ===================================================================== */
  let healthState = null; // { loaded, source, example }
  const healthDrop = $("#health-drop"), healthInput = $("#health-file");
  healthDrop.addEventListener("click", () => healthInput.click());
  healthDrop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); healthInput.click(); } });
  healthInput.addEventListener("change", () => { const f = healthInput.files && healthInput.files[0]; if (f) loadHealthFile(f); healthInput.value = ""; });
  dropZone(healthDrop, dt => { const f = dt.files && dt.files[0]; if (f) loadHealthFile(f); });
  $$("[data-health]").forEach(b => b.addEventListener("click", runHealthExample));
  $("#health-dir").addEventListener("change", () => healthState && renderHealth());
  $("#health-name").addEventListener("change", () => healthState && renderHealth());
  $("#health-live").addEventListener("click", runHealthLive);

  async function loadHealthFile(file) {
    setHash("health");
    try {
      const text = await file.text();
      const loaded = /\.json$/i.test(file.name) || /^\s*[[{]/.test(text) ? R.health.loadRequests(R.health.requestsFromJson(JSON.parse(text))) : R.health.loadCounts(text);
      healthState = { loaded, source: "Source: " + file.name };
      renderHealth();
    } catch (e) {
      put($("#health-out"), alertBox("err", "Couldn't read that file.", e.message || String(e)));
    }
  }

  function runHealthExample() {
    selectTab("health");
    setHash("health", "pumpfun");
    $("#health-name").value = "Pump.fun"; $("#health-dir").value = "buy";
    healthState = { loaded: R.health.loadCounts(R.examples.pumpfunDailyCsv), source: "Source: Pump.fun's published A/B export, reduced to daily counts by OpenChainBench", example: true };
    renderHealth();
  }

  async function runHealthLive() {
    const key = $("#health-key").value.trim();
    const out = $("#health-out");
    if (!key) { put(out, alertBox("err", "Add an API key first.", "Live data comes from /requests/v3, which needs a Relay API key.")); return; }
    setHash("health");
    const label = h("span", {}, "Fetching requests from /requests/v3…");
    put(out, h("div", { class: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), label));
    try {
      const since = Math.floor(Date.now() / 1000) - Number($("#health-since").value) * 86400;
      const { requests } = await R.api.getRequests({ version: "v3", apiKey: key, max: 2000, params: { appId: $("#health-app").value.trim() || undefined, startTimestamp: since, sortBy: "createdAt" }, onPage: n => { label.textContent = `Fetched ${fmtNum(n)} requests…`; } });
      healthState = { loaded: R.health.loadRequests(requests), source: `Source: live /requests/v3, ${requests.length} requests` };
      renderHealth();
    } catch (e) {
      put(out, alertBox("err", "Couldn't fetch live data.", e.message || String(e)));
    }
  }

  function renderHealth() {
    const out = $("#health-out");
    let a;
    try { a = R.health.analyze(healthState.loaded, { direction: $("#health-dir").value || undefined }); }
    catch (e) { put(out, alertBox("err", "Couldn't analyse that data.", e.message || String(e))); return; }
    const name = $("#health-name").value.trim() || "Integrator";
    const html = R.report.render(a, { name, source: healthState.source });
    const email = R.health.draftEmail(a, { name });
    const frame = h("iframe", { class: "report-frame", title: "Health report for " + name, sandbox: "allow-same-origin allow-popups allow-popups-to-escape-sandbox" });
    frame.srcdoc = html;
    frame.addEventListener("load", () => { themeFrame(frame); fitFrame(frame); });
    put(out,
      h("div", { class: "toolbar" },
        h("div", { class: "left" }, `${fmtNum(a.trades)} ${a.filters.direction ? a.filters.direction + "s" : "requests"}, ${R.health.pct(a.rate)} errored. The report below is the same file the command line writes.`),
        h("div", { class: "right" },
          h("button", { type: "button", class: "secondary", onclick: () => copy(email, "Email draft") }, "Copy email draft"),
          h("button", { type: "button", class: "secondary", onclick: () => download("relay-health-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".html", html, "text/html") }, "Download report"),
          healthState.example ? h("button", { type: "button", class: "secondary", onclick: shareLink }, "Copy link") : null)),
      h("div", { style: "margin-top:14px" }, frame));
  }
  function themeFrame(f) {
    try { const doc = f.contentDocument; if (doc && doc.documentElement) doc.documentElement.dataset.theme = effectiveTheme(); } catch { /* not ready */ }
  }
  function fitFrame(f) {
    try {
      const doc = f.contentDocument; if (!doc) return;
      const fit = () => { f.style.height = (doc.documentElement.scrollHeight + 2) + "px"; };
      fit();
      if (window.ResizeObserver) new ResizeObserver(fit).observe(doc.body);
      doc.querySelectorAll("a[href^='http']").forEach(a => { a.target = "_blank"; a.rel = "noopener"; });
    } catch { /* cross-origin: keep default height */ }
  }

  /* ---------- shared ---------- */
  function dropZone(el, onDrop) {
    ["dragenter", "dragover"].forEach(t => el.addEventListener(t, e => { e.preventDefault(); el.classList.add("over"); }));
    ["dragleave", "drop"].forEach(t => el.addEventListener(t, e => { e.preventDefault(); el.classList.remove("over"); }));
    el.addEventListener("drop", e => onDrop(e.dataTransfer));
  }

  $("#ver").textContent = "Version " + R.version + ", " + R.scan.RULE_COUNT + " code checks, " + Object.keys(R.engine.ERRORS).length + " fail reasons explained";
  window.addEventListener("hashchange", readHash);
  selectTab("ticket");
  setTimeout(() => routeShown || playRoute({ from: "Base", to: "Arbitrum", outcome: "delivered", status: "Delivered", detail: "An example transfer. Look one up to see its route." }), 350);
  readHash();
})();
