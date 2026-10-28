"use strict";
/* Self-contained HTML health report. No external scripts, styles or fonts, so it opens anywhere and can be emailed. */
const { OWNER_LABEL } = require("./engine");
const { OWNERS, draftEmail } = require("./health");

const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pct = (x, d = 1) => (x == null ? "—" : (x * 100).toFixed(d) + "%");
const num = n => Number(n || 0).toLocaleString("en-US");
const OWNER_COLOR = { relay: "var(--o-relay)", integrator: "var(--o-int)", user: "var(--o-user)", market: "var(--o-market)", token_or_chain: "var(--o-token)", unknown: "var(--o-unknown)" };

function ownerBars(a) {
  const rows = a.byChain.filter(c => c.trades > 0);
  const maxRate = Math.max(0.05, ...rows.map(c => c.rate));
  const W = 760, left = 150, right = 120, barW = W - left - right, rowH = 40, top = 10;
  const H = top + rows.length * rowH + 10;
  const x = r => left + (r / maxRate) * barW;
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Error rate by chain, split by who can fix it" class="chart">`;
  rows.forEach((c, i) => {
    const y = top + i * rowH;
    svg += `<text x="0" y="${y + 15}" class="lbl">${esc(c.chain)}</text><text x="0" y="${y + 30}" class="sub">${num(c.trades)} trades</text>`;
    let acc = 0;
    for (const o of OWNERS) {
      const n = c.owners[o]; if (!n) continue;
      const r = n / c.trades, x0 = x(acc); acc += r;
      svg += `<rect x="${x0.toFixed(1)}" y="${y + 4}" width="${Math.max(0.5, x(acc) - x0).toFixed(1)}" height="24" fill="${OWNER_COLOR[o]}"><title>${esc(c.chain)}: ${esc(OWNER_LABEL[o])} ${pct(r)} of trades (${num(n)} errors)</title></rect>`;
    }
    svg += `<text x="${(x(c.rate) + 8).toFixed(1)}" y="${y + 21}" class="val">${pct(c.rate)}</text>`;
  });
  return svg + "</svg>";
}

function dailyChart(points, chain, spikes) {
  const pts = points.filter(p => p.trades > 0);
  if (pts.length < 2) return "";
  const W = 360, H = 130, l = 40, r = 10, t = 26, b = 22;
  const maxR = Math.max(0.05, ...pts.map(p => p.rate)) * 1.15;
  const X = i => l + (i / (pts.length - 1)) * (W - l - r), Y = v => t + (1 - v / maxR) * (H - t - b);
  const line = pts.map((p, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.rate).toFixed(1)).join(" ");
  const relayLine = pts.map((p, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.owners.relay / p.trades).toFixed(1)).join(" ");
  const sp = new Set(spikes.filter(s => s.chain === chain).map(s => s.day));
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="mini" role="img" aria-label="${esc(chain)} daily error rate"><text x="0" y="14" class="lbl">${esc(chain)}</text>`;
  for (const g of [0, maxR / 2]) svg += `<line x1="${l}" x2="${W - r}" y1="${Y(g).toFixed(1)}" y2="${Y(g).toFixed(1)}" class="grid"/><text x="${l - 6}" y="${(Y(g) + 4).toFixed(1)}" class="tick" text-anchor="end">${pct(g, 0)}</text>`;
  svg += `<path d="${relayLine}" class="ln-relay"/><path d="${line}" class="ln-all"/>`;
  pts.forEach((p, i) => { svg += `<circle cx="${X(i).toFixed(1)}" cy="${Y(p.rate).toFixed(1)}" r="${sp.has(p.day) ? 4.5 : 2.5}" class="${sp.has(p.day) ? "dot-spike" : "dot"}"><title>${esc(p.day)}: ${pct(p.rate)} of ${num(p.trades)} trades (Relay-side ${pct(p.owners.relay / p.trades)})</title></circle>`; });
  svg += `<text x="${l}" y="${H - 6}" class="tick">${esc(pts[0].day.slice(5))}</text><text x="${W - r}" y="${H - 6}" class="tick" text-anchor="end">${esc(pts.at(-1).day.slice(5))}</text>`;
  return svg + "</svg>";
}

function render(a, { name = "Integrator", source = "", generatedAt = new Date().toISOString() } = {}) {
  const email = draftEmail(a, { name });
  const ownerLegend = OWNERS.filter(o => a.ownerSplit[o]).map(o => `<span class="key"><i style="background:${OWNER_COLOR[o]}"></i>${esc(OWNER_LABEL[o])} ${pct(a.errors ? a.ownerSplit[o] / a.errors : 0, 0)} of errors</span>`).join("");
  const chainsWithDays = a.byChain.filter(c => c.trades >= 500 && (a.series[c.chain] || []).filter(p => p.trades).length >= 2);
  const actions = a.actions.map(x => `<li class="act"><span class="who who-${esc(String(x.who).toLowerCase().replace(/[^a-z]/g, ""))}">${esc(x.who)}</span><div><b>${esc(x.title)}</b><p>${esc(x.detail)}</p></div></li>`).join("");
  const hasExamples = Object.keys(a.examples).length > 0;
  const reasons = a.reasons.slice(0, 12).map(r => `<tr><td><code>${esc(r.reason)}</code></td><td>${esc(OWNER_LABEL[r.owner] || r.owner)}</td><td class="n">${num(r.n)}</td><td class="n">${pct(a.errors ? r.n / a.errors : 0)}</td>${hasExamples ? `<td><code>${esc((a.examples[r.reason] || []).join(", "))}</code></td>` : ""}</tr>`).join("");
  const stuck = a.stuck.slice(0, 20).map(s => `<tr><td><code>${esc(s.id)}</code></td><td>${esc(s.status)}</td><td>${esc((s.origin || "?") + " → " + s.chain)}</td><td class="n">${num(s.minutes)} min</td></tr>`).join("");
  const dirs = a.directions.length > 1 ? `<p class="note">${a.directions.map(d => `${esc(d.direction)}: ${pct(d.rate)} of ${num(d.trades)}`).join(" · ")}</p>` : "";
  const asm = a.assumptions.filter(x => x.assumed || x.label);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relay health report: ${esc(name)}</title>
<style>
:root{--bg:#f5f6f4;--panel:#fff;--fg:#15201b;--muted:#5d6a63;--line:#d8dfdb;--accent:#0d6b62;--o-relay:#2f6fd6;--o-int:#c77b12;--o-user:#7a5bbf;--o-market:#4f9a6b;--o-token:#b04a5a;--o-unknown:#b9c1bd;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f1513;--panel:#161e1b;--fg:#e3ebe7;--muted:#98a69f;--line:#2b3733;--accent:#4cc3b3;--o-relay:#6c9cf0;--o-int:#e3a14a;--o-user:#a98be6;--o-market:#74c393;--o-token:#e07b8b;--o-unknown:#56605b;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0f1513;--panel:#161e1b;--fg:#e3ebe7;--muted:#98a69f;--line:#2b3733;--accent:#4cc3b3;--o-relay:#6c9cf0;--o-int:#e3a14a;--o-user:#a98be6;--o-market:#74c393;--o-token:#e07b8b;--o-unknown:#56605b;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-left)) 48px max(16px,env(safe-area-inset-right))}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:0 0 12px}.muted{color:var(--muted)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;margin-top:16px;min-width:0}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.kpi b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.kpi span{color:var(--muted);font-size:13px}
.acts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}.act{display:grid;grid-template-columns:120px minmax(0,1fr);gap:12px}.act p{margin:2px 0 0;color:var(--muted)}
.who{font-size:12px;font-weight:600;border-radius:999px;padding:3px 9px;align-self:start;text-align:center;background:var(--bg);border:1px solid var(--line)}.who-relay{color:var(--o-relay)}.who-integrator{color:var(--o-int)}
@media (max-width:600px){.act{grid-template-columns:1fr}}
.chart,.mini{width:100%;height:auto;font-size:12px}.lbl{fill:var(--fg);font-weight:600}.sub,.tick{fill:var(--muted);font-size:11px}.val{fill:var(--fg);font-weight:600}
.grid{stroke:var(--line)}.ln-all{fill:none;stroke:var(--fg);stroke-width:2}.ln-relay{fill:none;stroke:var(--o-relay);stroke-width:1.5;stroke-dasharray:4 3}.dot{fill:var(--fg)}.dot-spike{fill:var(--o-int);stroke:var(--panel);stroke-width:1.5}
.minis{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.keys{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 10px;font-size:13px;color:var(--muted)}.key i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}code{font:12.5px ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}
pre{white-space:pre-wrap;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:14px;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;margin:0}
.note{font-size:13px;color:var(--muted)}footer{margin-top:24px;font-size:12.5px;color:var(--muted)}
</style></head><body><div class="wrap">
<h1>Relay health report: ${esc(name)}</h1>
<div class="muted">${a.period ? esc(a.period.from) + " to " + esc(a.period.to) + " · " : ""}${a.filters.direction ? esc(a.filters.direction) + "s only · " : ""}${esc(source)}</div>
<div class="kpis">
 <div class="kpi"><b>${num(a.trades)}</b><span>${a.filters.direction ? esc(a.filters.direction) + "s" : "requests"} completed or failed</span></div>
 <div class="kpi"><b>${pct(a.rate)}</b><span>error rate (${num(a.errors)} errors)</span></div>
 <div class="kpi"><b>${pct(a.errors ? a.ownerSplit.relay / a.errors : 0, 0)}</b><span>of errors on Relay's side</span></div>
 <div class="kpi"><b>${pct(a.errors ? a.ownerSplit.integrator / a.errors : 0, 0)}</b><span>of errors fixable by the integrator</span></div>
 ${a.open ? `<div class="kpi"><b>${num(a.open)}</b><span>still open${a.stuck.length ? ", " + num(a.stuck.length) + " over 30 min" : ""}</span></div>` : ""}
</div>
<section class="panel"><h2>What to do</h2>${actions ? `<ul class="acts">${actions}</ul>` : `<p class="muted">Nothing stands out. Error rates are steady across chains and days.</p>`}</section>
<section class="panel"><h2>Errors by chain, split by who can fix them</h2><div class="keys">${ownerLegend}</div>${ownerBars(a)}${dirs}</section>
${chainsWithDays.length ? `<section class="panel"><h2>Daily error rate</h2><div class="keys"><span class="key"><i style="background:var(--fg)"></i>all errors</span><span class="key"><i style="background:var(--o-relay)"></i>Relay-side errors</span><span class="key"><i style="background:var(--o-int)"></i>a day that stood out</span></div><div class="minis">${chainsWithDays.map(c => dailyChart(a.series[c.chain], c.chain, a.spikes)).join("")}</div></section>` : ""}
<section class="panel scroll"><h2>Top error reasons</h2><table><thead><tr><th>Reason</th><th>Likely owner</th><th class="n">Errors</th><th class="n">Share</th>${hasExamples ? "<th>Example request IDs</th>" : ""}</tr></thead><tbody>${reasons}</tbody></table></section>
${stuck ? `<section class="panel scroll"><h2>Requests open for over 30 minutes</h2><table><thead><tr><th>Request</th><th>Status</th><th>Route</th><th class="n">Since update</th></tr></thead><tbody>${stuck}</tbody></table></section>` : ""}
<section class="panel"><h2>Draft email to the integrator</h2><pre>${esc(email)}</pre></section>
<section class="panel"><h2>How this was worked out</h2>
<ul class="note">
<li>Error rate = failed or refunded ÷ (completed + failed + refunded). Requests still in progress are left out of the rate.</li>
<li>"Likely owner" maps each Relay fail reason to who can fix it, using Relay's Handling Execution Errors docs. It's a support heuristic, not an official classification.</li>
<li>A day stands out when its rate is at least 1.5× and 2 points above the same chain's other days. A chain is flagged when an owner's error rate is at least double, and 3 points above, the integrator's other chains.</li>
${asm.map(x => `<li>Label <code>${esc(x.label)}</code>: ${esc(x.note)}</li>`).join("")}
</ul></section>
<footer>Generated by relay-crosscheck on ${esc(generatedAt.slice(0, 16).replace("T", " "))} UTC. Independent tool; not an official Relay product.</footer>
</div></body></html>`;
}

module.exports = { render };
