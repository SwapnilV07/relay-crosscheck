"use strict";
/* Node entry point for the scanner: reads files from disk and hands them to scan-core. */
const fs = require("fs");
const path = require("path");
const core = require("./scan-core");

function collect(root, { includeTests = false } = {}) {
  const files = [];
  const st = fs.statSync(root);
  const base = st.isDirectory() ? root : path.dirname(root);
  const walk = p => {
    let s; try { s = fs.lstatSync(p); } catch { return; }
    if (s.isSymbolicLink()) return;
    if (s.isDirectory()) {
      if (core.SKIP_DIRS.has(path.basename(p)) && p !== root) return;
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
      return;
    }
    const rel = path.relative(base, p) || path.basename(p);
    if (!core.wantPath(rel, { includeTests, size: s.size })) return;
    const f = core.prepare(rel, fs.readFileSync(p, "utf8"));
    if (f) files.push(f);
  };
  walk(root);
  return files;
}

function scan(root, { today, maxPerRule, includeTests = false } = {}) {
  return core.scanFiles(collect(root, { includeTests }), { root, today, maxPerRule });
}

module.exports = { scan, collect, toSarif: core.toSarif, SEV_RANK: core.SEV_RANK };
