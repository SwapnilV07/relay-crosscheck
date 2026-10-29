"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FX = p => path.join(__dirname, "fixtures", p);
const engine = require("../src/engine");
const { scan, toSarif } = require("../src/scan");
const health = require("../src/health");
const report = require("../src/report");
const NODE_FETCH = global.fetch; // some tests below replace fetch with a mock

/* ---------- engine ---------- */
test("reason table covers exactly the fail reasons in Relay's API schema", () => {
  const schema = fs.readFileSync(FX("schema-fail-reasons.txt"), "utf8").trim().split("\n");
  const ours = Object.keys(engine.ERRORS);
  assert.deepEqual(schema.filter(c => !ours.includes(c)), [], "missing from table");
  assert.deepEqual(ours.filter(c => !schema.includes(c)), [], "not in schema");
  assert.deepEqual(ours.filter(c => !engine.OWNER[c]), [], "every code has a likely owner");
});

test("diagnoses a real successful transfer with a gas top-up", () => {
  const raw = JSON.parse(fs.readFileSync(FX("requests-v2-wallet.json"), "utf8")).requests[1];
  const n = engine.normalize(raw);
  const d = engine.diagnose(n, Date.parse("2026-10-29T00:00:00Z"));
  assert.equal(n.status, "success");
  assert.equal(d.sev, "ok");
  assert.equal(d.escalation, null);
  assert.ok(d.findings.some(f => /gas top-up/i.test(f.label + " " + f.detail)));
  assert.match(d.userReply, /gas top-up/);
});

/* ---------- scan ---------- */
const LEGACY_EXPECTED = ["fallback-type-removed", "include-protocol-signature", "old-contract-address", "quote-without-api-key", "slippage-format", "strict-deposit-without-refundto", "requests-v2", "api-key-in-url", "failure-treated-as-final", "fast-polling", "no-refund-handling", "old-sdk-package", "webhook-without-signature", "delayed-status", "ignored-liquidity-params", "na-string-check", "outdated-sdk", "tx-hash-field", "v2-response-fields", "token-price-v1", "config-v2-retiring", "token-price-number"];

test("scan finds every planted problem in the legacy app", () => {
  const r = scan(FX("legacy-app"), { today: "2026-10-29", includeTests: true });
  assert.deepEqual(r.findings.map(f => f.rule).sort(), [...LEGACY_EXPECTED].sort());
});

test("scan reports nothing for a correct modern integration", () => {
  const r = scan(FX("modern-app"), { today: "2026-10-29", includeTests: true });
  assert.deepEqual(r.findings.map(f => f.rule), []);
});

test("a passed deadline becomes breaking", () => {
  const before = scan(FX("legacy-app"), { today: "2026-11-23", includeTests: true }).findings.find(f => f.rule === "requests-v2");
  const after = scan(FX("legacy-app"), { today: "2026-11-24", includeTests: true }).findings.find(f => f.rule === "requests-v2");
  assert.equal(before.severity, "deadline");
  assert.equal(after.severity, "breaking");
});

test("scan skips test folders and comments by default", () => {
  const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "rd-"));
  fs.mkdirSync(path.join(tmp, "src")); fs.mkdirSync(path.join(tmp, "tests"));
  fs.writeFileSync(path.join(tmp, "src", "a.ts"), "// we used to call https://api.relay.link/requests/v2 here\nexport const x = 1;\n");
  fs.writeFileSync(path.join(tmp, "tests", "b.test.ts"), "fetch('https://api.relay.link/requests/v2?user=0x1')\n");
  assert.equal(scan(tmp).findings.length, 0);
  assert.ok(scan(tmp, { includeTests: true }).findings.some(f => f.rule === "requests-v2"));
});

test("SARIF output is well formed", () => {
  const s = toSarif(scan(FX("legacy-app"), { today: "2026-10-29", includeTests: true }));
  assert.equal(s.version, "2.1.0");
  const res = s.runs[0].results;
  assert.ok(res.length >= LEGACY_EXPECTED.length);
  for (const x of res) { assert.ok(x.ruleId); assert.ok(x.locations[0].physicalLocation.region.startLine >= 1); }
});

/* ---------- health ---------- */
const pumpDaily = () => health.loadCounts(fs.readFileSync(path.join(ROOT, "examples", "pumpfun-relay-ab-daily.csv"), "utf8"));

test("health reproduces Pump.fun's published buy error rate", () => {
  const a = health.analyze(pumpDaily(), { direction: "buy" });
  assert.equal(a.trades, 102513);
  assert.equal(a.errors, 11496);
  assert.equal((a.rate * 100).toFixed(1), "11.2");
  assert.equal(a.ownerSplit.relay, 6134);
  assert.equal(a.ownerSplit.integrator, 4083);
});

test("daily and total exports agree", () => {
  const tot = health.analyze(health.loadCounts(fs.readFileSync(path.join(ROOT, "examples", "pumpfun-relay-ab-totals.csv"), "utf8")), { direction: "buy" });
  const day = health.analyze(pumpDaily(), { direction: "buy" });
  assert.equal(tot.trades, day.trades);
  assert.equal(tot.errors, day.errors);
});

test("health flags BNB Chain as a standing Relay-side hotspot and the Robinhood sponsorship spike", () => {
  const a = health.analyze(pumpDaily(), { direction: "buy" });
  const bnb = a.hotspots.find(h => h.chain === "BNB Chain" && h.owner === "relay");
  assert.ok(bnb, "BNB hotspot");
  assert.equal(bnb.daysAbove, 10);
  assert.ok(a.spikes.some(s => s.chain === "Robinhood Chain" && s.day === "2026-09-29" && s.kind === "integrator"));
  assert.ok(a.assumptions.some(x => x.label === "sponsorship" && x.assumed));
});

test("health from request data: owners, open requests and stuck detection", () => {
  const real = JSON.parse(fs.readFileSync(FX("requests-v2-wallet.json"), "utf8")).requests;
  const mk = (id, status, failReason, minutesAgo) => ({ id, status, user: "0x1", createdAt: new Date(Date.parse("2026-10-14T07:00:00Z") - minutesAgo * 60e3).toISOString(), updatedAt: new Date(Date.parse("2026-10-14T07:00:00Z") - minutesAgo * 60e3).toISOString(),
    data: { failReason, inTxs: [{ hash: "0x" + "ab".repeat(32), chainId: 8453, timestamp: 1 }], outTxs: [], metadata: { currencyIn: { currency: { chainId: 8453, symbol: "USDC" }, amountFormatted: "1" }, currencyOut: { currency: { chainId: 42161, symbol: "USDC" }, amountFormatted: "1" } } } });
  const list = [...real, mk("0x" + "11".repeat(32), "refund", "SLIPPAGE", 60), mk("0x" + "22".repeat(32), "failure", "SPONSOR_BALANCE_TOO_LOW", 50), mk("0x" + "33".repeat(32), "pending", "N/A", 45)];
  const a = health.analyze(health.loadRequests(list), { asOf: Date.parse("2026-10-14T07:00:00Z") });
  assert.equal(a.trades, 5);
  assert.equal(a.errors, 2);
  assert.equal(a.ownerSplit.market, 1);
  assert.equal(a.ownerSplit.integrator, 1);
  assert.equal(a.stuck.length, 1);
  assert.equal(a.stuck[0].minutes, 45);
  assert.ok(a.examples.SPONSOR_BALANCE_TOO_LOW[0].startsWith("0x22"));
});

test("HTML report escapes untrusted text", () => {
  const csv = "chain,outcome,error_class,rows\n<script>x</script>,error,<img src=x>,5\nbase,success,none,95\n";
  const html = report.render(health.analyze(health.loadCounts(csv)), { name: "<b>Evil</b>" });
  assert.ok(!html.includes("<script>x</script>"));
  assert.ok(!html.includes("<img src=x>"));
  assert.ok(html.includes("&lt;b&gt;Evil&lt;/b&gt;"));
});

test("health rejects input it can't use, with a clear message", () => {
  assert.throws(() => health.loadCounts("a,b\n1,2\n"), /No usable rows/);
  assert.throws(() => health.analyze(pumpDaily(), { direction: "swap" }), /No rows left/);
});

/* ---------- ticket, against recorded Relay responses ---------- */
function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = new URL(url); calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), headers: opts && opts.headers });
    for (const r of routes) if (r.match(u)) { const body = typeof r.body === "function" ? r.body(u) : r.body; return { ok: (r.status || 200) < 400, status: r.status || 200, headers: new Map(), text: async () => JSON.stringify(body) }; }
    return { ok: false, status: 404, headers: new Map(), text: async () => JSON.stringify({ message: "not found" }) };
  };
  return calls;
}
const realWallet = () => JSON.parse(fs.readFileSync(FX("requests-v2-wallet.json"), "utf8"));
const TX3 = "0x17919601915dd5023b5721469f529e973c3ed86a2042c8363fd856c00078a739";
const TX3_FILL = "0x3e85eca72b4731ce737894bda2315ba99bf1868d8040479bde5dbf6dfe1ebee2";

test("ticket: request ID resolves through /requests/v2?id", async () => {
  delete require.cache[require.resolve("../src/ticket")];
  const calls = mockFetch([{ match: u => u.pathname === "/requests/v2" && u.searchParams.get("id") === TX3, body: { requests: [realWallet().requests[0]] } }]);
  const { lookup, diagnoseAll } = require("../src/ticket");
  const found = await lookup(TX3);
  const [r] = diagnoseAll(found, Date.parse("2026-10-29T00:00:00Z"));
  assert.equal(r.request.id, TX3);
  assert.equal(r.diagnosis.headline, "Delivered");
  assert.ok(calls.some(c => c.path === "/requests/v2" && c.query.id === TX3));
});

test("ticket: a fill hash falls back to /requests/v2?hash", async () => {
  const calls = mockFetch([
    { match: u => u.pathname === "/requests/v2" && u.searchParams.get("id"), body: { requests: [] } },
    { match: u => u.pathname === "/requests/v2" && u.searchParams.get("hash") === TX3_FILL, body: { requests: [realWallet().requests[0]] } },
  ]);
  const { lookup } = require("../src/ticket");
  const found = await lookup(TX3_FILL);
  assert.equal(found.requests[0].id, TX3);
  assert.deepEqual(calls.map(c => c.path), ["/intents/status/v3", "/requests/v2"], "status first, then one v2 call by hash");
});

test("ticket: falls back to the status API when /requests/v2 is gone", async () => {
  mockFetch([
    { match: u => u.pathname === "/requests/v2", status: 410, body: { message: "retired" } },
    { match: u => u.pathname === "/intents/status/v3", body: { status: "pending", inTxHashes: ["0x" + "cd".repeat(32)], txHashes: [], originChainId: 8453, destinationChainId: 792703809, updatedAt: Date.now() - 20 * 60e3, quoteCreatedAt: Date.now() - 22 * 60e3 } },
  ]);
  const { lookup, diagnoseAll } = require("../src/ticket");
  const found = await lookup(TX3);
  const [r] = diagnoseAll(found);
  assert.equal(found.source, "status v3");
  assert.equal(r.diagnosis.escalate, true, "pending for 20 minutes should escalate");
  assert.match(r.diagnosis.escalation, /Solana/);
});

test("ticket: with an API key, searches /requests/v3 and sends the key as a header", async () => {
  const calls = mockFetch([{ match: u => u.pathname === "/requests/v3", body: { requests: [] } }]);
  const { lookup } = require("../src/ticket");
  await lookup(TX3, { apiKey: "test-key" });
  assert.equal(calls[0].path, "/requests/v3");
  assert.equal(calls[0].query.term, TX3);
  assert.equal(calls[0].headers["x-api-key"], "test-key");
  assert.ok(!JSON.stringify(calls[0].query).includes("test-key"), "key never in the URL");
});

test("ticket: rejects input that isn't an ID, hash or wallet", async () => {
  const { lookup } = require("../src/ticket");
  await assert.rejects(() => lookup("hello"), /request ID or transaction hash/);
});

const LIVE = p => JSON.parse(fs.readFileSync(FX(path.join("live-2026-10-28", p)), "utf8"));

test("ticket (live responses): known request + v2 rate-limited gives a status-only diagnosis", async () => {
  mockFetch([
    { match: u => u.pathname === "/intents/status/v3", body: LIVE("status-v3-success.json") },
    { match: u => u.pathname === "/requests/v2", status: 429, body: LIVE("requests-v2-429.json") },
  ]);
  const { lookup, diagnoseAll } = require("../src/ticket");
  const found = await lookup(TX3);
  const [r] = diagnoseAll(found);
  assert.equal(found.source, "status v3");
  assert.equal(r.diagnosis.headline, "Delivered");
  assert.equal(r.request.failReason, null, "\"N/A\" is treated as no reason");
  assert.ok(found.notes.some(n => /rate-limited/.test(n)));
});

test("ticket (live responses): unknown ID + v2 rate-limited returns nothing, with a useful note", async () => {
  const calls = mockFetch([
    { match: u => u.pathname === "/intents/status/v3", body: LIVE("status-v3-unknown.json") },
    { match: u => u.pathname === "/requests/v2", status: 429, body: LIVE("requests-v2-429.json") },
  ]);
  const { lookup } = require("../src/ticket");
  const found = await lookup("0x" + "00".repeat(32));
  assert.equal(found.requests.length, 0);
  assert.ok(found.notes.some(n => /--api-key/.test(n)));
  assert.equal(calls.filter(c => c.path === "/requests/v2").length, 1, "only one v2 call when it is rate-limited");
});

test("api: a 429 without Retry-After is not retried", async () => {
  const calls = mockFetch([{ match: u => u.pathname === "/requests/v2", status: 429, body: LIVE("requests-v2-429.json") }]);
  const api = require("../src/api");
  await assert.rejects(() => api.get("/requests/v2", { user: "0x1" }), /429/);
  assert.equal(calls.length, 1);
});

/* ---------- CLI ---------- */
const CLI = path.join(ROOT, "bin", "relay-crosscheck.js");
test("CLI: scan exits 1 on breaking problems and 0 on a clean app", () => {
  assert.equal(spawnSync("node", [CLI, "scan", FX("legacy-app"), "--include-tests"]).status, 1);
  assert.equal(spawnSync("node", [CLI, "scan", FX("modern-app"), "--include-tests"]).status, 0);
  assert.equal(spawnSync("node", [CLI, "scan", FX("legacy-app"), "--include-tests", "--fail-on", "none"]).status, 0);
});

test("CLI: health writes an HTML report and an email", () => {
  const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "rd-"));
  execFileSync("node", [CLI, "health", "--counts", path.join(ROOT, "examples", "pumpfun-relay-ab-daily.csv"), "--direction", "buy", "--name", "Pump.fun", "--html", path.join(out, "r.html"), "--email", path.join(out, "e.txt")]);
  assert.match(fs.readFileSync(path.join(out, "r.html"), "utf8"), /BNB Chain/);
  assert.match(fs.readFileSync(path.join(out, "e.txt"), "utf8"), /^Subject: /);
});

test("CLI: bad arguments give a clear error and exit 2", () => {
  const r = spawnSync("node", [CLI, "health"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Give a source/);
});

/* ---------- web app bundle ---------- */
test("web: docs/crosscheck.js is up to date with src/", () => {
  const { build, stamp, OUT, INDEX } = require("../scripts/build-web");
  const bundle = build();
  assert.equal(fs.readFileSync(OUT, "utf8"), bundle, "run: node scripts/build-web.js");
  const html = fs.readFileSync(INDEX, "utf8");
  assert.equal(html, stamp(html, bundle), "index.html must load the current app.css, app.js and crosscheck.js (run: node scripts/build-web.js)");
});

test("web: the browser bundle gives the same scan and health results as the command line", () => {
  const vm = require("vm");
  const ctx = { console, URL, setTimeout }; ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "docs", "crosscheck.js"), "utf8"), ctx);
  const W = ctx.RelayCrosscheck;
  const files = W.examples.legacyApp.filter(f => W.scan.wantPath(f.path, { includeTests: true })).map(f => W.scan.prepare(f.path, f.text)).filter(Boolean);
  const web = W.scan.scanFiles(files, { today: "2026-10-29" });
  const cli = scan(FX("legacy-app"), { today: "2026-10-29", includeTests: true });
  assert.deepEqual(JSON.parse(JSON.stringify(web.findings)), JSON.parse(JSON.stringify(cli.findings.map(f => ({ ...f, locations: f.locations.map(l => ({ ...l, file: l.file.split(path.sep).join("/") })) })))));
  const a = W.health.analyze(W.health.loadCounts(W.examples.pumpfunDailyCsv), { direction: "buy" });
  assert.equal(a.errors, 11496);
  assert.equal(W.scan.RULE_COUNT, require("../src/scan-core").RULE_COUNT);
});

/* ---------- Relay watch ---------- */
const watch = require("../scripts/watch-relay");
const DOCS_FX = p => fs.readFileSync(FX(path.join("relay-docs-2026-10-29", p)), "utf8");

test("watch: parses Relay's changelog into dated entries with change kinds", () => {
  const entries = watch.parseChangelog(DOCS_FX("changelog.mdx"));
  assert.equal(entries.length, 8);
  assert.equal(entries[0].date, "2026-10-28");
  const kit = entries.find(e => e.date === "2026-10-26");
  assert.ok(kit.kinds.Breaking.some(b => /useRelayConfig/.test(b)), "a RelayKit major version counts as breaking");
  const api = entries.find(e => e.date === "2026-10-21");
  assert.equal(api.kinds.Breaking.length, 3);
});

test("watch: flags only entries after the reviewed date, and nothing when up to date", () => {
  const changelog = DOCS_FX("changelog.mdx"), errorsDoc = DOCS_FX("execution-errors.mdx");
  const now = watch.findGaps({ changelog, errorsDoc, coverage: JSON.parse(fs.readFileSync(path.join(ROOT, "watch", "coverage.json"), "utf8")) });
  assert.deepEqual(now.gaps, [], "every published change is reviewed");
  const older = watch.findGaps({ changelog, errorsDoc, coverage: { changelogCoveredThrough: "2026-10-20" } });
  assert.deepEqual(older.gaps.map(g => g.key), ["2026-10-28", "2026-10-26", "2026-10-23", "2026-10-21"]);
  assert.equal(older.gaps.find(g => g.key === "2026-10-23").priority, "review", "an Added/Changed-only entry is low priority");
  const router = watch.findGaps({ changelog, errorsDoc, coverage: { changelogCoveredThrough: "2026-10-13" } }).gaps.find(g => g.key === "2026-10-14");
  assert.ok(!/doesn't know yet/.test(router.body), "the v3.2 router addresses are already known");
});

test("watch: notices a fail reason Relay added to its docs or API schema", () => {
  const errorsDoc = DOCS_FX("execution-errors.mdx") + "\n| `BRAND_NEW_REASON` | Something new. |\n";
  const schema = { components: { schemas: { Req: { properties: { failReason: { type: "string", enum: Object.keys(engine.ERRORS).concat("SCHEMA_ONLY_REASON") } } } } } };
  assert.deepEqual(watch.parseSchemaCodes(schema).filter(c => !engine.ERRORS[c]), ["SCHEMA_ONLY_REASON"]);
  const { gaps } = watch.findGaps({ changelog: DOCS_FX("changelog.mdx"), errorsDoc, schema, coverage: { changelogCoveredThrough: "2099-01-01" } });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0].title, /BRAND_NEW_REASON, SCHEMA_ONLY_REASON/);
});

test("watch: opens each issue once and skips ones that already exist", async () => {
  const http = require("http");
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", c => (body += c)); req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: body && JSON.parse(body) });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url.endsWith("/labels")) { res.statusCode = 422; return res.end(JSON.stringify({ message: "already_exists" })); }
      if (req.method === "GET") return res.end(JSON.stringify([{ title: "Already open" }]));
      res.statusCode = 201; res.end(JSON.stringify({ html_url: "https://github.com/o/r/issues/7" }));
    });
  });
  await new Promise(r => server.listen(0, r));
  process.env.GITHUB_API_URL = "http://127.0.0.1:" + server.address().port;
  global.fetch = NODE_FETCH;
  try {
    const opened = await watch.openIssues([{ title: "Already open", body: "x" }, { title: "New one", body: "y" }], { repo: "o/r", token: "t" });
    assert.deepEqual(opened.map(o => o.title), ["New one"]);
    const posts = seen.filter(s => s.method === "POST" && s.url === "/repos/o/r/issues");
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body.labels, ["relay-watch"]);
    assert.equal(posts[0].auth, "Bearer t");
  } finally { delete process.env.GITHUB_API_URL; server.close(); }
});

/* ---------- "why was the fee so high?" ---------- */
const walletReqs = () => JSON.parse(fs.readFileSync(FX("requests-v2-wallet.json"), "utf8")).requests;
const NOW = Date.parse("2026-10-29T00:00:00Z");

test("cost: splits a real transfer into gas, swap, Relay fee and app fee that add up to the total", () => {
  const d = engine.diagnose(engine.normalize(walletReqs()[0]), NOW);
  assert.equal(d.cost.phase, "actual");
  assert.equal(d.cost.main.key, "swap");
  const total = d.findings.find(f => /^Total cost/.test(f.label));
  assert.match(total.label, /\$0\.04/);
  assert.match(total.detail, /Mostly the swap from USDC to ETH \(\$0\.03\): exchange fees and price impact\./);
  assert.equal(d.findings.filter(f => /cost|top-up|categor/i.test(f.label)).length, 1, "cost is explained in one finding");
  assert.ok(Math.abs(d.cost.gross - 0.0382) < 0.001, "parts add up to the cost: " + d.cost.gross);
  assert.match(d.userReply, /Most of that \(\$0\.03\) is the cost of converting USDC to ETH/);
  assert.match(d.devReply, /cost \(actual, USD\): execution 0\.0042, swap 0\.0312, platform 0\.0024, app 0\.0000/);
});

test("cost: a gas top-up the user received is not blamed as a fee", () => {
  for (const raw of walletReqs().slice(1)) {
    const n = engine.normalize(raw);
    const d = engine.diagnose(n, NOW);
    assert.ok(Math.abs(d.cost.gasTopup - n.gasTopup.usd) < 1e-9);
    const userCost = n.amountIn.usd - n.amountOut.usd - n.gasTopup.usd;
    assert.ok(Math.abs(d.cost.gross - userCost) < 0.02, `parts ${d.cost.gross} vs cost ${userCost}`);
    assert.ok(d.cost.parts.every(p => p.usd < 0.1), "no $2 'fee' left in any line");
    const total = d.findings.find(f => /^Total cost/.test(f.label));
    assert.match(total.detail, /of gas the user chose to receive \(gas top-up\)/);
    assert.ok(!d.findings.some(f => /Includes a gas top-up|Costs moved/.test(f.label)), "no duplicate cost findings");
  }
  const toBase = engine.diagnose(engine.normalize(walletReqs()[2]), NOW);
  assert.match(toBase.userReply, /goes to the Ethereum network, not to us\. Ethereum's network fees are the highest/);
  const sameToken = engine.diagnose(engine.normalize(walletReqs()[1]), NOW);
  assert.match(sameToken.userReply, /cost of moving USDC from one network to another/);
});

test("cost: an app fee is named as the app's, not Relay's, and flagged when it makes the cost high", () => {
  const raw = JSON.parse(JSON.stringify(walletReqs()[0]));
  raw.data.metadata.currencyIn.amountUsd = "10"; raw.data.metadata.currencyOut.amountUsd = "8.40";
  raw.data.expandedPriceImpact.actual = { swap: { usd: "-0.05" }, execution: { usd: "-0.04" }, relay: { usd: "-0.01" }, app: { usd: "-1.50" } };
  const d = engine.diagnose(engine.normalize(raw), NOW);
  assert.equal(d.cost.main.key, "app");
  const f = d.findings.find(x => /^Total cost/.test(x.label));
  assert.equal(f.tone, "warn");
  assert.match(f.detail, /App fee \$1\.50 · Swap cost \$0\.05 · Network gas \$0\.04/);
  assert.match(f.detail, /Mostly the app's own fee, which Relay doesn't set or keep\./);
  assert.match(d.userReply, /fee charged by the app or wallet you used\. That fee is set by the app, not by Relay/);
});

test("cost: reads the v3 shape (data.fees, platform) and explains expensive Ethereum delivery", () => {
  const raw = JSON.parse(JSON.stringify(walletReqs()[0]));
  raw.data.metadata.currencyOut.currency.chainId = 1; raw.data.outTxs[0].chainId = 1;
  raw.data.metadata.currencyIn.amountUsd = "20"; raw.data.metadata.currencyOut.amountUsd = "16.80";
  raw.data.expandedPriceImpact.actual = { swap: { usd: "-0.10" }, execution: { usd: "-3.00" }, relay: { usd: "-0.10" }, app: { usd: "0" }, sponsored: { usd: "0" } };
  const v2 = engine.diagnose(engine.normalize(raw), NOW);
  assert.equal(v2.cost.main.key, "execution");
  assert.match(v2.userReply, /network fee for delivering your funds on Ethereum.*bigger share.*Base or Arbitrum costs less/);
  const n = engine.normalize(raw);
  n.fees = { quoted: null, actual: { swap: -0.10, execution: -3.00, platform: -0.10, app: 0, sponsored: 1.0 } };
  const cb = engine.costBreakdown(n);
  assert.equal(cb.parts.find(p => p.key === "platform").usd, 0.10);
  assert.equal(cb.sponsored, 1.0);
  assert.ok(Math.abs(cb.userPays - 2.2) < 1e-9);
});

test("scan: big repositories read Relay code first, so a file limit never cuts it", () => {
  const core = require("../src/scan-core");
  const paths = ["apps/web/a.ts", "docs/guide.ts", "zz/lib/relay/client.ts", "packages/ui/Button.tsx", "package.json", "src/bridge/quote.ts", "src/RelayStatus.tsx", "test/x.test.ts"];
  const order = core.prioritize(paths.map(path => ({ path }))).map(x => x.path);
  assert.deepEqual(order.slice(0, 2), ["zz/lib/relay/client.ts", "src/RelayStatus.tsx"], "anything named Relay comes first");
  assert.equal(order[2], "package.json");
  assert.equal(order[3], "src/bridge/quote.ts");
  assert.ok(order.indexOf("apps/web/a.ts") < order.indexOf("docs/guide.ts"), "app source before docs");
});
