#!/usr/bin/env node
"use strict";
/*
 * Weekly check that the scan rules and the fail-reason table still match what Relay has published.
 * Run by .github/workflows/watch.yml. It reads:
 *   - Relay's changelog (changelog.mdx in the public relayprotocol/relay-docs repository)
 *   - the Handling Execution Errors page in the same repository
 *   - Relay's OpenAPI schema (api.relay.link/documentation/json), when reachable
 * and opens one GitHub issue for each thing this project doesn't cover yet. Issues are never duplicated.
 *
 *   node scripts/watch-relay.js --dry-run                       print what it would open
 *   node scripts/watch-relay.js --changelog-file x.mdx ...      use local copies (tests)
 *
 * After adding the rules for a changelog entry, move "changelogCoveredThrough" in watch/coverage.json to its date.
 */
const fs = require("fs");
const path = require("path");
const { ERRORS } = require("../src/engine");
const { OLD_CONTRACTS, CURRENT_CONTRACTS } = require("../src/rules");

const ROOT = path.join(__dirname, "..");
const DOCS_RAW = "https://raw.githubusercontent.com/relayprotocol/relay-docs/main/";
const CHANGELOG_URL = DOCS_RAW + "changelog.mdx";
const ERRORS_URL = DOCS_RAW + "references/api/api_core_concepts/execution-errors.mdx";
const SCHEMA_URL = "https://api.relay.link/documentation/json";
const LABEL = "relay-watch";
const ACTION_KINDS = ["Breaking", "Behavior change", "Deprecated", "Removed", "Replacement"];

/* ---------- parsing ---------- */

/* Splits changelog.mdx into entries: { date, tags, kinds: { "Breaking": [text, …], … }, raw } */
function parseChangelog(mdx) {
  const entries = [];
  const re = /<Update\s+label="(\d{4}-\d{2}-\d{2})"(?:\s+tags=\{\[([^\]]*)\]\})?[^>]*>([\s\S]*?)<\/Update>/g;
  let m;
  while ((m = re.exec(mdx))) {
    const tags = (m[2] || "").split(",").map(t => t.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    const kinds = {};
    let kind = null, bullet = null;
    const flush = () => { if (bullet && kind) (kinds[kind] = kinds[kind] || []).push(clean(bullet)); bullet = null; };
    for (const line of m[3].split(/\r?\n/)) {
      const k = line.match(/^\*\*([^*]+)\*\*\s*$/);
      if (k) { flush(); kind = k[1].trim(); continue; }
      const versionHead = line.match(/^\*\*([^*]+)\*\*\s*[—-]\s*(\w+)/); // RelayKit "**Hooks `6.0.0`** — Major"
      if (versionHead) { flush(); kind = versionHead[2] === "Major" ? "Breaking" : "Changed"; bullet = null; continue; }
      if (/^###\s/.test(line)) { flush(); continue; }
      if (/^\s*-\s+/.test(line)) { flush(); bullet = line.replace(/^\s*-\s+/, ""); continue; }
      if (bullet && /^\s+\S/.test(line)) { bullet += " " + line.trim(); continue; }
      if (!line.trim()) flush();
    }
    flush();
    entries.push({ date: m[1], tags, kinds, raw: m[3] });
  }
  return entries;
}
const clean = s => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();

/* Error codes listed in the docs tables: | `CODE` | description | */
function parseErrorCodes(mdx) {
  const out = new Set();
  for (const m of mdx.matchAll(/^\|\s*`([A-Z][A-Z0-9_]{3,})`\s*\|/gm)) out.add(m[1]);
  return [...out].sort();
}

/* failReason / refundFailReason enums anywhere in the OpenAPI document. */
function parseSchemaCodes(schema) {
  const out = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== "object" || depth > 40) return;
    for (const [k, v] of Object.entries(o)) {
      if (/^(failReason|refundFailReason)$/.test(k) && v && typeof v === "object") {
        const deref = x => (x && x.$ref && x.$ref.startsWith("#/") ? x.$ref.slice(2).split("/").reduce((o, p) => (o ? o[p] : null), schema) : x) || {};
        const t = deref(v);
        const en = t.enum || (t.anyOf || t.oneOf || []).map(deref).flatMap(x => x.enum || []);
        for (const e of en || []) if (typeof e === "string" && /^[A-Z][A-Z0-9_]+$/.test(e)) out.add(e);
      }
      walk(v, depth + 1);
    }
  };
  walk(schema, 0);
  return [...out].sort();
}

/* ---------- deciding what is new ---------- */

function findGaps({ changelog, errorsDoc, schema, coverage }) {
  const gaps = [];
  const known = new Set([...Object.keys(OLD_CONTRACTS), ...Object.keys(CURRENT_CONTRACTS)]);
  for (const e of parseChangelog(changelog)) {
    if (e.date <= coverage.changelogCoveredThrough) continue;
    const kindNames = Object.keys(e.kinds);
    const needsAction = kindNames.some(k => ACTION_KINDS.includes(k));
    const addresses = [...new Set((e.raw.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g) || []).map(a => a.toLowerCase()))].filter(a => !known.has(a));
    const title = `Relay changelog ${e.date}${e.tags.length ? " (" + e.tags.join(", ") + ")" : ""}: review for scan rules`;
    let body = `Relay published a changelog entry on **${e.date}** that this project hasn't reviewed yet.\n\n`;
    body += needsAction
      ? `It includes **${kindNames.filter(k => ACTION_KINDS.includes(k)).join(", ")}** changes, which integrators may have to act on, so it probably needs a scan rule.\n`
      : `It only lists ${kindNames.join(", ") || "notes"}, so it may not need a rule. Skim it and close this issue if not.\n`;
    for (const k of kindNames) {
      body += `\n**${k}**\n\n` + e.kinds[k].map(b => "- " + (b.length > 600 ? b.slice(0, 600) + "…" : b)).join("\n") + "\n";
    }
    if (addresses.length) body += `\nContract addresses mentioned that the scanner doesn't know yet: ${addresses.map(a => "`" + a + "`").join(", ")}. If they are Relay contracts, add them to \`src/rules.js\`.\n`;
    body += `\nSource: https://docs.relay.link/changelog\n\n**To close this out**\n- [ ] Add or update rules in \`src/rules.js\`, with a fixture in \`test/fixtures/legacy-app\`\n- [ ] Run \`npm test\` and \`node scripts/build-web.js\`\n- [ ] Set \`changelogCoveredThrough\` in \`watch/coverage.json\` to \`${e.date}\`\n`;
    gaps.push({ kind: "changelog", key: e.date, title, body, priority: needsAction ? "action" : "review" });
  }

  const ours = new Set(Object.keys(ERRORS));
  const fromDocs = errorsDoc ? parseErrorCodes(errorsDoc) : [];
  const fromSchema = schema ? parseSchemaCodes(schema) : [];
  const published = new Set([...fromDocs, ...fromSchema]);
  const missing = [...published].filter(c => !ours.has(c)).sort();
  if (missing.length) {
    const title = `New Relay fail reasons not in the table: ${missing.join(", ")}`;
    let body = `Relay now publishes ${missing.length === 1 ? "a fail reason" : "fail reasons"} that \`src/engine.js\` doesn't explain yet:\n\n`;
    body += missing.map(c => `- \`${c}\`${fromDocs.includes(c) ? " (docs)" : ""}${fromSchema.includes(c) ? " (API schema)" : ""}`).join("\n");
    body += `\n\nUntil they're added, \`ticket\` shows them as "not in the reference table yet" and \`health\` counts them as unknown owner.\n\n**To close this out**\n- [ ] Add each code to \`ERRORS\` and \`OWNER_GROUPS\` in \`src/engine.js\`\n- [ ] Add it to \`test/fixtures/schema-fail-reasons.txt\`\n- [ ] Run \`npm test\` and \`node scripts/build-web.js\`\n\nSources: https://docs.relay.link/references/api/api_core_concepts/execution-errors and ${SCHEMA_URL}\n`;
    gaps.push({ kind: "fail-reasons", key: missing.join(","), title, body, priority: "action" });
  }
  if (fromSchema.length) {
    const gone = [...ours].filter(c => !fromSchema.includes(c) && !fromDocs.includes(c)).sort();
    if (gone.length) gaps.push({ kind: "fail-reasons-removed", key: gone.join(","), title: `Fail reasons no longer published by Relay: ${gone.join(", ")}`, body: `These codes are in \`src/engine.js\` but no longer appear in Relay's API schema or docs:\n\n${gone.map(c => "- `" + c + "`").join("\n")}\n\nKeep them if old requests can still return them; otherwise remove them and update \`test/fixtures/schema-fail-reasons.txt\`.\n`, priority: "review" });
  }
  return { gaps, stats: { changelogEntries: parseChangelog(changelog).length, docCodes: fromDocs.length, schemaCodes: fromSchema.length } };
}

/* ---------- GitHub ---------- */

async function github(method, url, token, body) {
  const res = await fetch((process.env.GITHUB_API_URL || "https://api.github.com") + url, {
    method, headers: { accept: "application/vnd.github+json", authorization: "Bearer " + token, "user-agent": "relay-crosscheck-watch", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok && !(method === "POST" && url.endsWith("/labels") && res.status === 422)) throw new Error(`GitHub ${method} ${url}: ${res.status} ${json && json.message}`);
  return json;
}

async function openIssues(gaps, { repo, token }) {
  await github("POST", `/repos/${repo}/labels`, token, { name: LABEL, color: "0d6b62", description: "Relay changed something this project may not cover yet" });
  const existing = new Set();
  for (let page = 1; page <= 10; page++) {
    const list = await github("GET", `/repos/${repo}/issues?labels=${LABEL}&state=all&per_page=100&page=${page}`, token);
    list.forEach(i => existing.add(i.title));
    if (list.length < 100) break;
  }
  const opened = [];
  for (const g of gaps) {
    if (existing.has(g.title)) continue;
    const issue = await github("POST", `/repos/${repo}/issues`, token, { title: g.title, body: g.body + "\n\n_Opened by the weekly Relay watch (`scripts/watch-relay.js`)._", labels: [LABEL] });
    opened.push({ title: g.title, url: issue.html_url });
  }
  return opened;
}

/* ---------- main ---------- */

async function fetchText(url, { optional = false } = {}) {
  try {
    const r = await fetch(url, { headers: { "user-agent": "relay-crosscheck-watch" } });
    if (!r.ok) throw new Error(r.status + " " + r.statusText);
    return await r.text();
  } catch (e) {
    if (optional) { console.log(`Skipped ${url}: ${e.message}`); return null; }
    throw new Error(`Couldn't fetch ${url}: ${e.message}`);
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { const k = argv[i].slice(2); out[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true; }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const coverage = JSON.parse(fs.readFileSync(path.join(ROOT, "watch", "coverage.json"), "utf8"));
  const read = f => fs.readFileSync(f, "utf8");
  const changelog = args["changelog-file"] ? read(args["changelog-file"]) : await fetchText(CHANGELOG_URL);
  const errorsDoc = args["errors-file"] ? read(args["errors-file"]) : await fetchText(ERRORS_URL, { optional: true });
  const schemaText = args["schema-file"] ? read(args["schema-file"]) : (args["no-schema"] ? null : await fetchText(SCHEMA_URL, { optional: true }));
  let schema = null; try { schema = schemaText ? JSON.parse(schemaText) : null; } catch { console.log("The API schema wasn't valid JSON; skipped."); }

  const { gaps, stats } = findGaps({ changelog, errorsDoc, schema, coverage });
  if (!stats.changelogEntries) throw new Error("Found no entries in Relay's changelog. Its format may have changed; check scripts/watch-relay.js.");

  const lines = [`## Relay watch`, ``, `Read ${stats.changelogEntries} changelog entries (reviewed through ${coverage.changelogCoveredThrough}), ${stats.docCodes} fail reasons in the docs, ${schema ? stats.schemaCodes + " in the API schema" : "API schema not reachable"}.`, ``];
  if (!gaps.length) lines.push("Nothing new. Every published change up to now is covered.");
  for (const g of gaps) lines.push(`- ${g.priority === "action" ? "**Needs a rule:** " : "Review: "}${g.title}`);

  const repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN;
  if (gaps.length && !args["dry-run"] && repo && token) {
    const opened = await openIssues(gaps, { repo, token });
    lines.push("", opened.length ? `Opened ${opened.length} issue${opened.length > 1 ? "s" : ""}:` : "All of these already have issues.");
    opened.forEach(o => lines.push(`- [${o.title}](${o.url})`));
  } else if (gaps.length) {
    lines.push("", args["dry-run"] ? "Dry run: no issues opened." : "No GITHUB_TOKEN and GITHUB_REPOSITORY, so no issues opened.");
  }
  const summary = lines.join("\n");
  console.log(summary);
  if (args.verbose) for (const g of gaps) console.log("\n---\n# " + g.title + "\n\n" + g.body);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { parseChangelog, parseErrorCodes, parseSchemaCodes, findGaps, openIssues };
