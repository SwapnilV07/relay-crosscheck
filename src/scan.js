"use strict";
const fs = require("fs");
const path = require("path");
const { LINE_RULES, REPO_RULES } = require("./rules");

const EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".rb", ".php", ".cs", ".sol"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "vendor", "target", "__pycache__", ".venv", "venv", ".turbo", ".cache", ".yarn"]);
const MAX_BYTES = 1024 * 1024;
const SEV_RANK = { breaking: 4, deadline: 3, warning: 2, info: 1 };

const TEST_PATH = /(^|[\\/])(__tests__|__mocks__|tests?|spec|fixtures?|mocks?|e2e|cypress|playwright)([\\/]|$)|\.(test|spec|stories)\.[cm]?[jt]sx?$/i;
const GENERATED = /auto-?generated|do not (edit|make edits)|openapi-typescript|@generated/i;
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|#|<!--)/;

function collect(root, { includeTests = false } = {}) {
  const files = [];
  const st = fs.statSync(root);
  const base = st.isDirectory() ? root : path.dirname(root);
  const walk = p => {
    let s; try { s = fs.lstatSync(p); } catch { return; }
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p)) && p !== root) return;
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      return;
    }
    const isPkg = path.basename(p) === "package.json";
    if (!isPkg && !EXTS.has(path.extname(p).toLowerCase())) return;
    if (s.size > MAX_BYTES) return;
    if (/\.min\.js$|\.d\.ts$/.test(p)) return;
    const rel = path.relative(base, p) || path.basename(p);
    if (!includeTests && TEST_PATH.test(rel)) return;
    const text = fs.readFileSync(p, "utf8");
    if (!isPkg && GENERATED.test(text.split(/\r?\n/, 6).join("\n"))) return;
    // Comment-only lines are blanked (keeping line numbers) so no rule fires on a comment.
    const lines = isPkg ? text.split(/\r?\n/) : text.split(/\r?\n/).map(l => (COMMENT_LINE.test(l) ? "" : l));
    files.push({ path: rel, text: lines.join("\n"), lines });
  };
  walk(root);
  return files;
}

/* Effective severity: a deadline that has passed is breaking. */
function effectiveSeverity(rule, today) {
  if (rule.severity === "deadline" && rule.deadline && today >= rule.deadline) return "breaking";
  return rule.severity;
}

function scan(root, { today = new Date().toISOString().slice(0, 10), maxPerRule = 25, includeTests = false } = {}) {
  const files = collect(root, { includeTests });
  const findings = new Map();
  const add = (rule, loc, extra) => {
    if (!findings.has(rule.id)) findings.set(rule.id, { rule: rule.id, severity: effectiveSeverity(rule, today), title: rule.title, why: rule.why, fix: rule.fix, docs: rule.docs, deadline: rule.deadline || null, locations: [], total: 0 });
    const f = findings.get(rule.id);
    f.total++;
    if (f.locations.length < maxPerRule) f.locations.push({ file: loc.file, line: loc.line, text: (loc.text || "").trim().slice(0, 200), detail: extra || null });
  };
  for (const f of files) {
    if (path.basename(f.path) === "package.json") continue;
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
        locations: [{ physicalLocation: { artifactLocation: { uri: l.file.split(path.sep).join("/") }, region: { startLine: Math.max(1, l.line) } } }],
      }))),
    }],
  };
}

module.exports = { scan, toSarif, collect, SEV_RANK };
