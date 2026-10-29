"use strict";
/* The scanner without any file system access, so the same code runs in Node and in the browser.
   Callers hand it { path, text } pairs; scan.js reads them from disk, the web app from GitHub or a dropped folder. */
const { LINE_RULES, REPO_RULES } = require("./rules");

const EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".cs", ".sol"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "vendor", "target", "__pycache__", ".venv", "venv", ".turbo", ".cache", ".yarn"]);
const MAX_BYTES = 1024 * 1024;
const SEV_RANK = { breaking: 4, deadline: 3, warning: 2, info: 1 };

const TEST_PATH = /(^|[\\/])(__tests__|__mocks__|tests?|spec|fixtures?|mocks?|e2e|cypress|playwright)([\\/]|$)|\.(test|spec|stories)\.[cm]?[jt]sx?$/i;
const GENERATED = /auto-?generated|do not (edit|make edits)|openapi-typescript|@generated/i;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--)/;

const baseName = p => String(p).split(/[\\/]/).pop();
const extName = p => { const b = baseName(p); const i = b.lastIndexOf("."); return i > 0 ? b.slice(i).toLowerCase() : ""; };

/* Is this path worth reading at all? Checked before downloading, so the web app fetches as little as possible. */
function wantPath(rel, { includeTests = false, size = 0 } = {}) {
  const parts = String(rel).split(/[\\/]/);
  if (parts.slice(0, -1).some(d => SKIP_DIRS.has(d))) return false;
  const isPkg = baseName(rel) === "package.json";
  if (!isPkg && !EXTS.has(extName(rel))) return false;
  if (size > MAX_BYTES) return false;
  if (/\.min\.js$|\.d\.ts$/.test(rel)) return false;
  if (!includeTests && TEST_PATH.test(rel)) return false;
  return true;
}

/* Turns raw text into what the rules read. Returns null for generated files.
   Comment-only lines are blanked (keeping line numbers) so no rule fires on a comment. */
function prepare(rel, text) {
  const isPkg = baseName(rel) === "package.json";
  if (!isPkg && GENERATED.test(text.split(/\r?\n/, 6).join("\n"))) return null;
  const lines = isPkg ? text.split(/\r?\n/) : text.split(/\r?\n/).map(l => (COMMENT_LINE.test(l) ? "" : l));
  return { path: rel, text: lines.join("\n"), lines };
}

/* Effective severity: a deadline that has passed is breaking. */
function effectiveSeverity(rule, today) {
  if (rule.severity === "deadline" && rule.deadline && today >= rule.deadline) return "breaking";
  return rule.severity;
}

/* files: output of prepare(). */
function scanFiles(files, { root = "", today = new Date().toISOString().slice(0, 10), maxPerRule = 25 } = {}) {
  const findings = new Map();
  const add = (rule, loc, extra) => {
    if (!findings.has(rule.id)) findings.set(rule.id, { rule: rule.id, severity: effectiveSeverity(rule, today), title: rule.title, why: rule.why, fix: rule.fix, docs: rule.docs, deadline: rule.deadline || null, locations: [], total: 0 });
    const f = findings.get(rule.id);
    f.total++;
    if (f.locations.length < maxPerRule) f.locations.push({ file: loc.file, line: loc.line, text: (loc.text || "").trim().slice(0, 200), detail: extra || null });
  };
  for (const f of files) {
    if (baseName(f.path) === "package.json") continue;
    const rules = LINE_RULES.filter(r => !r.fileTest || r.fileTest(f.text));
    f.lines.forEach((line, i) => {
      if (line.length > 2000 || COMMENT_LINE.test(line)) return;
      for (const r of rules) if (r.test(line)) add(r, { file: f.path, line: i + 1, text: line }, r.detail ? r.detail(line) : null);
    });
  }
  for (const r of REPO_RULES) {
    const hit = r.check(files);
    if (hit) for (const h of [].concat(hit)) add(r, h);
  }
  const list = [...findings.values()].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.rule.localeCompare(b.rule));
  const counts = { breaking: 0, deadline: 0, warning: 0, info: 0 };
  for (const f of list) counts[f.severity]++;
  return { root, scannedFiles: files.length, today, findings: list, counts };
}

/* SARIF 2.1.0 so GitHub code scanning can show findings inline on pull requests. */
function toSarif(result) {
  const allRules = [...LINE_RULES, ...REPO_RULES];
  const level = s => (s === "breaking" || s === "deadline" ? "error" : s === "warning" ? "warning" : "note");
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json", version: "2.1.0",
    runs: [{
      tool: { driver: { name: "relay-crosscheck", informationUri: "https://github.com/SwapnilV07/relay-crosscheck", rules: allRules.map(r => ({ id: r.id, shortDescription: { text: r.title }, fullDescription: { text: r.why }, help: { text: r.fix + " " + r.docs }, helpUri: r.docs })) } },
      results: result.findings.flatMap(f => f.locations.map(l => ({
        ruleId: f.rule, level: level(f.severity),
        message: { text: f.title + (l.detail ? " (" + l.detail + ")" : "") + ". " + f.fix },
        locations: [{ physicalLocation: { artifactLocation: { uri: l.file.split("\\").join("/") }, region: { startLine: Math.max(1, l.line) } } }],
      }))),
    }],
  };
}

/* When a repository is too big to read every file, read the likely Relay code first.
   Tier 0: the path mentions Relay. 1: package.json (shows the SDK version). 2: names that usually hold
   bridge, quote or status code. 3: everything else, real source before tests and docs. */
const RELAY_PATH = /relay|reservoir/i;
const NEAR_PATH = /bridg|swap|quote|cross-?chain|xchain|intent|deposit|withdraw|solver|webhook|status|fill|route|chains?\b|api|client|sdk/i;
function pathTier(p) {
  if (RELAY_PATH.test(p)) return 0;
  if (baseName(p) === "package.json") return 1;
  if (NEAR_PATH.test(p)) return 2;
  return /(^|\/)(src|app|apps|lib|packages|server|services)\//.test(p) ? 3 : 4;
}
/* items: anything with a .path; returns a new array, most likely Relay code first, stable within a tier. */
function prioritize(items) {
  return items.map((it, i) => ({ it, i, t: pathTier(it.path) })).sort((a, b) => a.t - b.t || a.i - b.i).map(x => x.it);
}

const RULE_COUNT = LINE_RULES.length + REPO_RULES.length;

module.exports = { prioritize, pathTier, wantPath, prepare, scanFiles, toSarif, effectiveSeverity, SEV_RANK, EXTS, SKIP_DIRS, MAX_BYTES, RULE_COUNT };
