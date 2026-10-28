#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const { scan, toSarif } = require("../src/scan");
const health = require("../src/health");
const report = require("../src/report");
const ticket = require("../src/ticket");
const api = require("../src/api");
const { OWNER_LABEL, chainName, txUrl, fmtUtc, short } = require("../src/engine");
const pkg = require("../package.json");

/* ---------- tiny helpers ---------- */
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = s => c(1, s), dim = s => c(2, s), red = s => c(31, s), yellow = s => c(33, s), green = s => c(32, s), blue = s => c(34, s), cyan = s => c(36, s);
const SEV_STYLE = { breaking: s => red(bold(s)), deadline: s => red(s), warning: yellow, info: blue };

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) out[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}
const fail = msg => { console.error(red("Error: ") + msg); process.exit(2); };
const write = (file, text) => { fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true }); fs.writeFileSync(file, text); };

const HELP = `${bold("relay-crosscheck")} ${pkg.version}: support tooling for Relay integrations

${bold("Usage")}
  relay-crosscheck scan [path]          Check an integration's code against Relay's breaking changes
  relay-crosscheck health [source]      Error rates, who can fix them, and a draft email for an integrator
  relay-crosscheck ticket <id|hash|0x>  Look up a transfer and draft replies

${bold("scan")}
  --json                 Print results as JSON
  --sarif <file>         Write SARIF for GitHub code scanning
  --fail-on <level>      Exit 1 on: breaking (default), deadline, warning, info, none
  --include-tests        Also scan test and fixture files

${bold("health")}  (one source)
  --counts <file.csv>    Counts by day, chain, outcome and error label (e.g. an A/B export)
  --requests <file.json> Saved /requests/v2 or /requests/v3 responses
  --api-key <key>        Fetch live from /requests/v3 (or set RELAY_API_KEY)
      --app <app_id_...>   --chain <id>   --since <7d|24h|YYYY-MM-DD>   --max <n, default 2000>
  --user <0x...>         Fetch one wallet's requests (no key needed while /requests/v2 lives)
  options: --name <integrator>  --direction <buy|sell>  --lane <name>  --label-owner label=owner
           --html <file>  --email <file>  --json

${bold("ticket")}
  --api-key <key>        Search /requests/v3 (recommended)
  --reply <customer|integrator|escalation>   Print only that draft
  --json

Examples
  npx relay-crosscheck scan ./src
  npx relay-crosscheck health --counts examples/pumpfun-relay-ab-daily.csv --direction buy --name Pump.fun --html report.html
  npx relay-crosscheck ticket 0x17919601915dd5023b5721469f529e973c3ed86a2042c8363fd856c00078a739
`;

/* ---------- scan ---------- */
function cmdScan(args) {
  const target = args._[1] || ".";
  if (!fs.existsSync(target)) fail("Path not found: " + target);
  const res = scan(target, { includeTests: !!args["include-tests"], today: args.today });
  if (args.sarif) write(args.sarif, JSON.stringify(toSarif(res), null, 2));
  if (args.json) console.log(JSON.stringify(res, null, 2));
  else {
    console.log(bold("Relay Crosscheck scan") + dim(`  ${res.scannedFiles} files in ${path.resolve(target)}`));
    if (!res.findings.length) console.log(green("\nNo problems found against Relay's changes up to " + res.today + "."));
    for (const f of res.findings) {
      console.log("\n" + SEV_STYLE[f.severity](f.severity.toUpperCase()) + "  " + bold(f.title) + (f.deadline && f.severity === "deadline" ? dim("  (deadline " + f.deadline + ")") : ""));
      for (const l of f.locations.slice(0, 5)) console.log("  " + cyan(l.file + ":" + l.line) + "  " + dim(l.text.slice(0, 110)) + (l.detail ? dim("  [" + l.detail + "]") : ""));
      if (f.total > 5) console.log(dim("  …and " + (f.total - 5) + " more"));
      console.log("  Why: " + f.why);
      console.log("  Fix: " + f.fix);
      console.log("  " + dim(f.docs));
    }
    const k = res.counts;
    console.log("\n" + bold("Summary: ") + [red(k.breaking + " breaking"), red(k.deadline + " with a deadline"), yellow(k.warning + " warnings"), blue(k.info + " notes")].join(", "));
    if (args.sarif) console.log(dim("SARIF written to " + args.sarif));
  }
  const failOn = args["fail-on"] || "breaking";
  const LEVELS = { breaking: ["breaking"], deadline: ["breaking", "deadline"], warning: ["breaking", "deadline", "warning"], info: ["breaking", "deadline", "warning", "info"], none: [] };
  if (!LEVELS[failOn]) fail("--fail-on takes breaking, deadline, warning, info or none.");
  if (res.findings.some(f => LEVELS[failOn].includes(f.severity))) process.exitCode = 1;
}

/* ---------- health ---------- */
function sinceToSeconds(v) {
  if (!v) return Math.floor(Date.now() / 1000) - 7 * 86400;
  const m = String(v).match(/^(\d+)([hd])$/);
  if (m) return Math.floor(Date.now() / 1000) - Number(m[1]) * (m[2] === "h" ? 3600 : 86400);
  const t = Date.parse(v);
  if (isNaN(t)) fail("--since takes 7d, 24h or a date like 2026-10-01.");
  return Math.floor(t / 1000);
}

async function cmdHealth(args) {
  const labelOwners = {};
  for (const pair of [].concat(args["label-owner"] || [])) {
    if (pair === true) continue;
    const [k, v] = String(pair).split("=");
    if (!v || !OWNER_LABEL[v]) fail("--label-owner takes label=owner, owner one of: " + Object.keys(OWNER_LABEL).join(", "));
    labelOwners[k] = v;
  }
  let loaded, source;
  const apiKey = args["api-key"] || process.env.RELAY_API_KEY;
  if (args.counts) {
    loaded = health.loadCounts(fs.readFileSync(args.counts, "utf8"), { lane: args.lane, labelOwners });
    source = "Source: " + path.basename(args.counts);
  } else if (args.requests) {
    loaded = health.loadRequests(health.requestsFromJson(JSON.parse(fs.readFileSync(args.requests, "utf8"))));
    source = "Source: " + path.basename(args.requests);
  } else if (apiKey || args.user) {
    const v3 = !!apiKey;
    const params = v3 ? { appId: args.app, originChainId: undefined, chainId: args.chain, user: args.user, startTimestamp: sinceToSeconds(args.since), sortBy: "createdAt" } : { user: args.user };
    process.stderr.write(dim(`Fetching from /requests/${v3 ? "v3" : "v2"}…`));
    const { requests, deprecation } = await api.getRequests({ version: v3 ? "v3" : "v2", params, apiKey, max: Number(args.max) || 2000, onPage: n => process.stderr.write(dim(` ${n}`)) });
    process.stderr.write("\n");
    loaded = health.loadRequests(requests);
    source = `Source: live /requests/${v3 ? "v3" : "v2"}, ${requests.length} requests` + (deprecation ? " (v2 is deprecated)" : "");
  } else fail("Give a source: --counts, --requests, --api-key or --user. See relay-crosscheck --help.");

  const a = health.analyze(loaded, { direction: args.direction });
  const name = args.name || "Integrator";
  if (args.html) write(args.html, report.render(a, { name, source }));
  if (args.email) write(args.email, health.draftEmail(a, { name }));
  if (args.json) { console.log(JSON.stringify({ ...a, series: undefined }, null, 2)); return; }

  const P = health.pct;
  console.log(bold(`Relay health: ${name}`) + dim(`  ${a.period ? a.period.from + " to " + a.period.to : ""}${a.filters.direction ? ", " + a.filters.direction + "s" : ""}  ${source}`));
  console.log(`\n${a.trades.toLocaleString("en-US")} completed or failed, ${bold(P(a.rate))} errored (${a.errors.toLocaleString("en-US")})` + (a.open ? `, ${a.open} still open` : ""));
  console.log("Who can fix the errors: " + Object.entries(a.ownerSplit).filter(([, n]) => n).map(([o, n]) => `${OWNER_LABEL[o]} ${P(n / a.errors)}`).join(" · "));
  console.log("\n" + bold("By chain"));
  for (const ch of a.byChain) console.log(`  ${ch.chain.padEnd(18)} ${String(ch.trades.toLocaleString("en-US")).padStart(9)}  ${P(ch.rate).padStart(6)}   ` + dim(Object.entries(ch.owners).filter(([, n]) => n).map(([o, n]) => OWNER_LABEL[o] + " " + P(n / ch.trades)).join(", ")));
  console.log("\n" + bold("What to do"));
  if (!a.actions.length) console.log("  Nothing stands out.");
  a.actions.forEach((x, i) => console.log(`  ${i + 1}. [${x.who}] ${bold(x.title)}\n     ${x.detail}`));
  if (args.html) console.log("\n" + green("Report written to " + args.html));
  if (args.email) console.log(green("Email draft written to " + args.email));
}

/* ---------- ticket ---------- */
async function cmdTicket(args) {
  const q = args._[1];
  if (!q) fail("Give a request ID, transaction hash or wallet address.");
  const found = await ticket.lookup(q, { apiKey: args["api-key"] || process.env.RELAY_API_KEY });
  const results = ticket.diagnoseAll(found);
  if (args.json) { console.log(JSON.stringify({ source: found.source, notes: found.notes, results }, null, 2)); return; }
  if (!results.length) { console.log(yellow("No Relay request found for " + q + ".")); found.notes.forEach(n => console.log(dim(n))); process.exitCode = 1; return; }
  const pick = { customer: "userReply", integrator: "devReply", escalation: "escalation" };
  if (args.reply) {
    const k = pick[args.reply]; if (!k) fail("--reply takes customer, integrator or escalation.");
    const d = results[0].diagnosis;
    console.log(d[k] || "(No escalation needed for this request.)");
    return;
  }
  if (results.length > 1) console.log(dim(`${results.length} requests found (${found.source}). Showing all, newest first.\n`));
  for (const { request: n, diagnosis: d } of results) {
    const tone = { ok: green, warn: yellow, bad: red, info: blue }[d.sev] || (s => s);
    console.log(tone(bold(d.headline)) + "  " + dim(n.id));
    console.log(d.summary);
    console.log(dim(`${chainName(n.originChainId)} → ${chainName(n.destChainId)} · ${n.source} · https://relay.link/transaction/${n.id}`));
    console.log("\n" + bold("Findings"));
    for (const f of d.findings) console.log(`  ${({ ok: green("✓"), warn: yellow("!"), bad: red("✗"), info: blue("•") })[f.tone] || "•"} ${f.label}: ${dim(f.detail)}`);
    console.log("\n" + bold("Timeline"));
    for (const t of d.timeline) console.log(`  ${t.label.padEnd(16)} ${t.ts ? fmtUtc(t.ts) : "".padEnd(23)}  ${t.hash ? (txUrl(t.chainId, t.hash) || short(t.hash)) : ""}`);
    if (d.checks.length) { console.log("\n" + bold("Next checks")); d.checks.forEach((x, i) => console.log(`  ${i + 1}. ${x}`)); }
    console.log("\n" + bold("Reply to customer") + "\n" + d.userReply.split("\n").map(l => "  " + l).join("\n"));
    if (d.escalation) console.log("\n" + red(bold("Escalation note")) + "\n" + d.escalation.split("\n").map(l => "  " + l).join("\n"));
    console.log(dim("\nMore: --reply integrator for the developer reply, --json for everything.\n"));
  }
  found.notes.forEach(n => console.log(dim("Note: " + n)));
}

/* ---------- main ---------- */
(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (args.version) return console.log(pkg.version);
  if (!cmd || args.help || cmd === "help") return console.log(HELP);
  try {
    if (cmd === "scan") return cmdScan(args);
    if (cmd === "health") return await cmdHealth(args);
    if (cmd === "ticket") return await cmdTicket(args);
    fail("Unknown command '" + cmd + "'. Run relay-crosscheck --help.");
  } catch (e) {
    fail(e.message);
  }
})();
