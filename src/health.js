"use strict";
const { normalize, ownerOf, OWNER_LABEL, errInfo, chainName } = require("./engine");

/* Error labels that are not Relay fail codes but show up in integrator exports (e.g. Pump.fun's A/B file).
   Owners here are assumptions and are listed as such in every report. */
const LABEL_OWNER_DEFAULTS = {
  relay_failure: { owner: "relay", assumed: false, note: "Labelled as a Relay failure by the integrator." },
  sponsorship: { owner: "integrator", assumed: true, note: "Assumed to mean the integrator's fee-sponsorship App Balance ran short (SPONSOR_BALANCE_TOO_LOW). The source does not define this label; confirm with the integrator.", question: "We've read it as your fee-sponsorship balance running short (SPONSOR_BALANCE_TOO_LOW). Is that right?" },
  other: { owner: "unknown", assumed: false, note: "Not classified by the source." },
};

const ERR_PHRASE = { relay: "Relay-side errors", integrator: "integrator-side errors", user: "user errors", market: "price and liquidity errors", token_or_chain: "token or chain errors", unknown: "unlabelled errors", all: "errors" };
const OPEN = new Set(["waiting", "depositing", "pending", "submitted", "delayed"]);
const ERRORED = new Set(["failure", "refund"]);

/* ---------- loaders: everything becomes { day, chain, direction, outcome, reason, owner, n, ... } ---------- */

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.startsWith("#"));
  if (!lines.length) throw new Error("The CSV is empty.");
  const split = l => l.split(",").map(x => x.trim().replace(/^"|"$/g, ""));
  const header = split(lines[0]).map(h => h.toLowerCase());
  return lines.slice(1).map(l => { const v = split(l); const o = {}; header.forEach((h, i) => (o[h] = v[i])); return o; });
}

const CHAIN_ALIASES = { bsc: "BNB Chain", bnb: "BNB Chain", robinhood: "Robinhood Chain", base: "Base", arc: "Arc", ink: "Ink", eth: "Ethereum", ethereum: "Ethereum", arbitrum: "Arbitrum", optimism: "Optimism", polygon: "Polygon", solana: "Solana", hyperevm: "HyperEVM" };
const chainLabel = v => { if (v == null || v === "") return "all"; if (/^\d+$/.test(String(v))) return chainName(Number(v)); const k = String(v).toLowerCase(); return CHAIN_ALIASES[k] || String(v); };

function loadCounts(text, { lane, labelOwners = {} } = {}) {
  const rows = parseCsv(text);
  const col = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== "") return r[n]; return undefined; };
  const hasLane = rows.some(r => r.lane !== undefined);
  const laneFilter = lane || (hasLane ? "relay" : null);
  const assumptions = new Map();
  const recs = [];
  for (const r of rows) {
    if (laneFilter && hasLane && r.lane !== laneFilter) continue;
    const n = Number(col(r, "rows", "count", "n", "trades"));
    if (!Number.isFinite(n)) continue;
    const outcomeRaw = String(col(r, "outcome", "status") || "").toLowerCase();
    const outcome = /^(success|ok|filled)$/.test(outcomeRaw) ? "success" : /^(error|fail|failure|refund|failed)$/.test(outcomeRaw) ? "error" : OPEN.has(outcomeRaw) ? "open" : null;
    if (!outcome) continue;
    const reason = outcome === "error" ? (col(r, "error_class", "reason", "fail_reason", "failreason") || "UNSPECIFIED") : null;
    let owner = null;
    if (reason) {
      if (labelOwners[reason]) { owner = labelOwners[reason]; assumptions.set(reason, { owner, assumed: true, note: "Owner set on the command line." }); }
      else if (errInfo(reason) && ownerOf(reason) !== "unknown") owner = ownerOf(reason);
      else if (LABEL_OWNER_DEFAULTS[reason]) { owner = LABEL_OWNER_DEFAULTS[reason].owner; assumptions.set(reason, LABEL_OWNER_DEFAULTS[reason]); }
      else owner = "unknown";
    }
    recs.push({ day: col(r, "day", "date") || null, chain: chainLabel(col(r, "chain", "destination_chain", "chain_id")), direction: col(r, "direction") || null, outcome, reason, owner, n });
  }
  if (!recs.length) throw new Error("No usable rows. The CSV needs columns like chain, outcome, error_class and rows" + (laneFilter ? " (lane '" + laneFilter + "')" : "") + ".");
  return { records: recs, assumptions: [...assumptions.entries()].map(([label, a]) => ({ label, ...a })), source: "counts" };
}

function loadRequests(list) {
  const recs = [];
  let deprecation = null;
  for (const raw of list) {
    let n;
    try { n = normalize(raw); } catch { continue; }
    const st = String(n.status || "").toLowerCase();
    const outcome = st === "success" ? "success" : ERRORED.has(st) ? "error" : OPEN.has(st) ? "open" : null;
    if (!outcome) continue;
    const reason = outcome === "error" ? (n.failReason || n.refundFailReason || (st === "refund" ? "REFUND_NO_REASON" : "FAILURE_NO_REASON")) : null;
    const created = n.createdAt || n.updatedAt;
    recs.push({
      day: created ? new Date(created).toISOString().slice(0, 10) : null,
      chain: n.destChainId != null ? chainName(n.destChainId) : "unknown chain",
      origin: n.originChainId != null ? chainName(n.originChainId) : null,
      direction: null, outcome, reason, owner: reason ? ownerOf(reason) : null, n: 1,
      id: n.id, status: st, updatedAt: n.updatedAt || n.createdAt, createdAt: n.createdAt,
    });
  }
  if (!recs.length) throw new Error("No requests with a known status were found in the input.");
  return { records: recs, assumptions: [], source: "requests", deprecation };
}

/* Accepts a /requests response, an array of them, or an array of request objects. */
function requestsFromJson(json) {
  const arr = Array.isArray(json) ? json : [json];
  const out = [];
  for (const x of arr) {
    if (x && Array.isArray(x.requests)) out.push(...x.requests);
    else if (x && x.id && x.data) out.push(x);
  }
  return out;
}

/* ---------- analysis ---------- */
const OWNERS = ["integrator", "relay", "user", "market", "token_or_chain", "unknown"];

function analyze(loaded, opts = {}) {
  const { direction, minTrades = 200, spikeRatio = 1.5, spikeDelta = 0.02, stuckMinutes = 30, asOf } = opts;
  let recs = loaded.records;
  if (direction) recs = recs.filter(r => r.direction === direction);
  if (!recs.length) throw new Error("No rows left after filtering" + (direction ? " by direction '" + direction + "'" : "") + ".");

  const closed = recs.filter(r => r.outcome !== "open");
  const sum = (rs, f) => rs.reduce((a, r) => a + (f ? (f(r) ? r.n : 0) : r.n), 0);
  const trades = sum(closed), errors = sum(closed, r => r.outcome === "error");

  const ownerSplit = Object.fromEntries(OWNERS.map(o => [o, sum(closed, r => r.outcome === "error" && r.owner === o)]));

  const reasonsOf = rs => {
    const m = new Map();
    for (const r of rs) if (r.outcome === "error") m.set(r.reason, (m.get(r.reason) || 0) + r.n);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n, owner: rs.find(r => r.reason === reason).owner }));
  };

  const chains = [...new Set(closed.map(r => r.chain))];
  const byChain = chains.map(c => {
    const rs = closed.filter(r => r.chain === c);
    const t = sum(rs), e = sum(rs, r => r.outcome === "error");
    return { chain: c, trades: t, errors: e, rate: t ? e / t : 0, owners: Object.fromEntries(OWNERS.map(o => [o, sum(rs, r => r.outcome === "error" && r.owner === o)])), reasons: reasonsOf(rs) };
  }).sort((a, b) => b.trades - a.trades);

  const directions = [...new Set(closed.map(r => r.direction).filter(Boolean))].map(d => {
    const rs = closed.filter(r => r.direction === d); const t = sum(rs), e = sum(rs, r => r.outcome === "error");
    return { direction: d, trades: t, errors: e, rate: t ? e / t : 0 };
  });

  // daily series per chain, and spikes against the trailing 7-day pooled rate
  const days = [...new Set(closed.map(r => r.day).filter(Boolean))].sort();
  const series = {};
  const spikes = [];
  for (const c of chains) {
    const pts = days.map(d => {
      const rs = closed.filter(r => r.chain === c && r.day === d);
      const t = sum(rs), e = sum(rs, r => r.outcome === "error");
      return { day: d, trades: t, errors: e, rate: t ? e / t : null, owners: Object.fromEntries(OWNERS.map(o => [o, sum(rs, r => r.outcome === "error" && r.owner === o)])) };
    });
    series[c] = pts;
    // Baseline = the same chain's pooled rate on the other days in the window (leave-one-out).
    // Run daily, "other days" are the past days, so this is a trailing baseline in practice.
    pts.forEach((p, i) => {
      if (p.trades < minTrades || p.rate == null) return;
      const others = pts.filter((q, j) => j !== i && q.trades >= minTrades);
      if (others.length < 2) return;
      const bt = others.reduce((a, q) => a + q.trades, 0);
      const base = others.reduce((a, q) => a + q.errors, 0) / bt;
      const hits = [];
      if (p.rate >= base * spikeRatio && p.rate - base >= spikeDelta) hits.push({ kind: "all", rate: p.rate, baseline: base });
      for (const o of OWNERS) {
        const r = p.owners[o] / p.trades, b = others.reduce((a, q) => a + q.owners[o], 0) / bt;
        if (r >= b * spikeRatio && r - b >= spikeDelta) hits.push({ kind: o, rate: r, baseline: b });
      }
      for (const h of hits) spikes.push({ chain: c, day: p.day, trades: p.trades, ...h });
    });
  }
  // keep one spike per chain/day: the owner-level one with the biggest jump explains it best
  const byKey = new Map();
  for (const sp of spikes) { const k = sp.chain + sp.day; const cur = byKey.get(k); if (!cur || (sp.kind !== "all" && (cur.kind === "all" || sp.rate - sp.baseline > cur.rate - cur.baseline))) byKey.set(k, sp); }
  spikes.length = 0; spikes.push(...byKey.values());

  // hotspots: a chain whose error rate for one owner is far above the integrator's other chains, every day
  const hotspots = [];
  for (const c of byChain) {
    if (c.trades < minTrades * 5) continue;
    const rest = byChain.filter(x => x.chain !== c.chain);
    const rt = rest.reduce((a, x) => a + x.trades, 0);
    if (!rt) continue;
    for (const o of OWNERS) {
      if (o === "unknown") continue;
      const r = c.owners[o] / c.trades, b = rest.reduce((a, x) => a + x.owners[o], 0) / rt;
      const daysAbove = (series[c.chain] || []).filter(p => p.trades >= minTrades && p.owners[o] / p.trades >= b * 2).length;
      const daysTotal = (series[c.chain] || []).filter(p => p.trades >= minTrades).length;
      if (r >= b * 2 && r - b >= 0.03) hotspots.push({ chain: c.chain, owner: o, rate: r, othersRate: b, trades: c.trades, daysAbove, daysTotal });
    }
  }
  hotspots.sort((x, y) => (y.rate - y.othersRate) - (x.rate - x.othersRate));
  spikes.sort((a, b) => (b.rate - b.baseline) - (a.rate - a.baseline));

  // requests still open for too long (only when we have per-request data)
  const now = asOf || Math.max(...recs.map(r => r.updatedAt || 0), 0) || Date.now();
  const stuck = recs.filter(r => r.outcome === "open" && r.updatedAt && now - r.updatedAt > stuckMinutes * 60e3)
    .map(r => ({ id: r.id, status: r.status, chain: r.chain, origin: r.origin, minutes: Math.round((now - r.updatedAt) / 60e3) }))
    .sort((a, b) => b.minutes - a.minutes);

  // examples of errors per reason (request IDs), useful for escalations
  const examples = {};
  for (const r of recs) if (r.outcome === "error" && r.id) { (examples[r.reason] = examples[r.reason] || []); if (examples[r.reason].length < 3) examples[r.reason].push(r.id); }

  const out = {
    period: days.length ? { from: days[0], to: days.at(-1), days: days.length } : null,
    trades, errors, rate: trades ? errors / trades : 0, open: sum(recs.filter(r => r.outcome === "open")),
    ownerSplit, byChain, directions, reasons: reasonsOf(closed), series, spikes, hotspots, stuck, examples,
    assumptions: loaded.assumptions || [], source: loaded.source, filters: { direction: direction || null },
  };
  out.actions = recommend(out);
  return out;
}

/* ---------- recommendations, written for a support person ---------- */
const pct = x => (x * 100).toFixed(1) + "%";
const pp = x => (x * 100).toFixed(1) + " pts";

function recommend(a) {
  const acts = [];
  const share = o => (a.errors ? a.ownerSplit[o] / a.errors : 0);
  const top = (o) => a.reasons.filter(r => r.owner === o).slice(0, 3);

  for (const h of a.hotspots.slice(0, 3)) {
    acts.push({ who: OWNER_LABEL[h.owner], priority: 1,
      title: `${h.chain}: ${ERR_PHRASE[h.owner]} hit ${pct(h.rate)} of trades, against ${pct(h.othersRate)} on your other chains`,
      detail: (h.daysTotal >= 3 ? `It was at least double your other chains on ${h.daysAbove} of ${h.daysTotal} days${h.daysAbove >= h.daysTotal * 0.7 ? ", so it's a standing problem on this chain, not a one-day blip" : ""}. ` : "Daily volume is too low to check day by day, so treat this as a lead to confirm. ") + (h.owner === "relay" ? "Escalate to engineering with the chain, the reasons and example request IDs." : h.owner === "integrator" ? "Raise it with the integrator: something in their setup for this chain differs." : "Check what is different about this chain.") });
  }
  const rankKind = k => (k === "relay" || k === "integrator" ? 0 : k === "all" ? 1 : 2);
  for (const s of [...a.spikes].sort((x, y) => rankKind(x.kind) - rankKind(y.kind) || (y.rate - y.baseline) - (x.rate - x.baseline)).slice(0, 2)) {
    const who = s.kind === "all" ? "Support" : OWNER_LABEL[s.kind];
    acts.push({ who, priority: 1,
      title: `${s.chain} on ${s.day}: ${ERR_PHRASE[s.kind]} reached ${pct(s.rate)}, against ${pct(s.baseline)} on other days`,
      detail: s.kind === "relay" ? "Escalate with example request IDs from that day." : s.kind === "integrator" ? "Contact the integrator the same day with the reason and the fix." : "Check the reasons for that day before replying." });
  }
  if (share("integrator") >= 0.15) {
    const reasons = top("integrator");
    acts.push({ who: "Integrator", priority: 2, title: `${pct(share("integrator"))} of errors look fixable on the integrator's side`,
      detail: reasons.map(r => r.reason + " (" + r.n.toLocaleString("en-US") + "): " + fixFor(r.reason, a)).join(" ") });
  }
  if (share("relay") >= 0.15 && !a.hotspots.some(h => h.owner === "relay")) {
    const worst = a.byChain.filter(c => c.trades >= 500).sort((x, y) => y.owners.relay / y.trades - x.owners.relay / x.trades).slice(0, 2);
    acts.push({ who: "Relay", priority: 2, title: `${pct(share("relay"))} of errors are on Relay's side` + (worst.length ? `, worst on ${worst.map(c => c.chain + " (" + pct(c.owners.relay / c.trades) + " of trades)").join(" and ")}` : ""),
      detail: "Escalate with the top reasons and example request IDs. " + top("relay").map(r => r.reason + " (" + r.n.toLocaleString("en-US") + ")").join(", ") + "." });
  }
  if (share("user") >= 0.15) acts.push({ who: "End user", priority: 3, title: `${pct(share("user"))} of errors come from user mistakes`, detail: "Suggest UI checks to the integrator before submit: " + top("user").map(r => r.reason).join(", ") + ". Add these to the help center replies." });
  if (share("market") >= 0.15) acts.push({ who: "Market conditions", priority: 3, title: `${pct(share("market"))} of errors are price movement or liquidity`, detail: "Check the integrator's slippage settings and quote-to-execution time. " + top("market").map(r => r.reason).join(", ") + "." });
  if (share("unknown") >= 0.15) acts.push({ who: "Unknown", priority: 3, title: `${pct(share("unknown"))} of errors have no specific reason`, detail: "Ask the integrator for request IDs so these can be traced; unlabelled errors hide real problems." });
  if (a.stuck.length) acts.push({ who: "Support", priority: 1, title: `${a.stuck.length} request${a.stuck.length > 1 ? "s have" : " has"} been open for over 30 minutes`, detail: "Check them before the users write in. Oldest: " + a.stuck.slice(0, 3).map(s => s.id + " (" + s.status + ", " + s.minutes + " min)").join(", ") + "." });
  return acts.sort((x, y) => x.priority - y.priority);
}

function fixFor(reason, a, { forIntegrator = false } = {}) {
  const asm = (a.assumptions || []).find(x => x.label === reason);
  if (reason === "sponsorship" || reason === "SPONSOR_BALANCE_TOO_LOW") return (forIntegrator ? "if this is your fee-sponsorship balance running low, topping up the App Balance and setting a low-balance alert would stop these." : "top up the fee-sponsorship App Balance and set a low-balance alert" + (asm && asm.assumed ? " (confirm the label means this)." : "."));
  const e = errInfo(reason);
  return e ? e.dev : "check the request details.";
}

/* ---------- email to the integrator ---------- */
function draftEmail(a, { name = "there", fromName = "Relay Support" } = {}) {
  const lines = [];
  const period = a.period ? `${a.period.from} to ${a.period.to}` : "the period you shared";
  lines.push(`Subject: Your Relay integration health, ${period}`);
  lines.push("");
  lines.push(`Hi ${name} team,`);
  lines.push("");
  lines.push(`We looked at ${a.trades.toLocaleString("en-US")} of your Relay ${a.filters.direction ? a.filters.direction + "s" : "requests"} from ${period}. ${pct(a.rate)} errored. Here's what we found and what each side can do.`);
  lines.push("");
  const ours = a.actions.filter(x => x.who === "Relay");
  const rankKind = k => (k === "relay" || k === "integrator" ? 0 : k === "all" ? 1 : 2);
  const days = [...a.spikes].filter(s => s.kind !== "unknown").sort((x, y) => rankKind(x.kind) - rankKind(y.kind) || (y.rate - y.baseline) - (x.rate - x.baseline)).slice(0, 3);
  if (days.length) {
    lines.push("Days that stood out:");
    const YOU = { ...ERR_PHRASE, integrator: "errors on your side", relay: "errors on our side" };
    for (const s of days) lines.push(`- ${s.chain} on ${s.day}: ${YOU[s.kind]} at ${pct(s.rate)}, against ${pct(s.baseline)} on other days.`);
    lines.push("");
  }
  if (ours.length) {
    lines.push("What we're doing:");
    for (const x of ours) lines.push(`- ${x.title.replace("Relay-side errors", "errors on our side")}. We're escalating this to our engineering team and will update you.`);
    lines.push("");
  }
  const share = n => (a.errors ? pct(n / a.errors) : "");
  const yours = [];
  for (const r of a.reasons.filter(r => r.owner === "integrator").slice(0, 3)) yours.push(`- ${r.reason} (${r.n.toLocaleString("en-US")} errors, ${share(r.n)} of all errors): ${fixFor(r.reason, a, { forIntegrator: true })}`);
  const userReasons = a.reasons.filter(r => r.owner === "user").slice(0, 3);
  if (userReasons.length) yours.push(`- Your users hit ${userReasons.map(r => r.reason + " (" + r.n.toLocaleString("en-US") + ")").join(", ")}. A check before submit (balance, chain, token, amount) would stop most of these.`);
  const marketReasons = a.reasons.filter(r => r.owner === "market").slice(0, 3);
  if (marketReasons.length) yours.push(`- Price and liquidity errors: ${marketReasons.map(r => r.reason + " (" + r.n.toLocaleString("en-US") + ")").join(", ")}. Check your slippage setting and how long users take between quote and signing.`);
  if (yours.length) { lines.push("What you can fix on your side:"); lines.push(...yours); lines.push(""); }
  const asm = (a.assumptions || []).filter(x => x.assumed);
  if (asm.length) {
    lines.push("One question for you:");
    for (const x of asm) lines.push(`- What does the "${x.label}" label in your data mean? ${x.question || "We've made an assumption about it; can you confirm?"}`);
    lines.push("");
  }
  lines.push("Happy to go through this on a call. Reply here with any request IDs you want us to trace.");
  lines.push("");
  lines.push(`Thanks,\n${fromName}`);
  return lines.join("\n");
}

module.exports = { loadCounts, loadRequests, requestsFromJson, analyze, draftEmail, parseCsv, OWNERS, LABEL_OWNER_DEFAULTS, pct };
