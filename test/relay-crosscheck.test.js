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
  assert.ok(d.findings.some(f => /gas top-up/i.test(f.label)));
  assert.match(d.userReply, /gas top-up/);
});

/* ---------- scan ---------- */
const LEGACY_EXPECTED = ["fallback-type-removed", "include-protocol-signature", "old-contract-address", "quote-without-api-key", "slippage-format", "strict-deposit-without-refundto", "requests-v2", "api-key-in-url", "failure-treated-as-final", "fast-polling", "no-refund-handling", "old-sdk-package", "webhook-without-signature", "delayed-status", "ignored-liquidity-params", "na-string-check", "outdated-sdk", "tx-hash-field", "v2-response-fields"];

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
