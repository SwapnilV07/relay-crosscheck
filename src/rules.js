"use strict";
/*
 * Scan rules. Every rule comes from Relay's public changelog or docs, and links to the page it came from.
 * severity: breaking  = already fails today
 *           deadline  = will fail on `deadline` (treated as breaking once the date has passed)
 *           warning   = works today but is risky or wrong
 *           info      = worth knowing, usually before a migration
 */
const DOCS = "https://docs.relay.link";
const L = (s) => DOCS + s;

const OLD_CONTRACTS = {
  // v2, v2.1 and v3 Router / ApprovalProxy addresses (Contract Addresses page). v3.2 replaced them on 26 Oct 2026.
  "0x113a327221d2c4660684449bfc39bc14ad1aaf38": "v2 Router", "0xf5042e6ffac5a625d4e7848e0b01373d8eb9e222": "v2 Router", "0x8fdceeda2951a9747feaf25311435448bce47b2a": "v2 Router",
  "0xcd740b0e005cb8647f9baf4febedc8753ceef861": "v2 ApprovalProxy", "0xbbbfd134e9b44bfb5123898ba36b01de7ab93d98": "v2 ApprovalProxy", "0xaec31c3780521c34ca59dc2eb5fb9ee2e285cebe": "v2 ApprovalProxy",
  "0xb758f3bfa7b9d39ef5457d7c7ffb3702f2ad3982": "v2.1 Router", "0x3ec130b627944cad9b2750300ecb0a695da522b6": "v2.1 Router",
  "0x953c95146eb8ce763f35caf2f1d46ddf6a33bea2": "v2.1 ApprovalProxy", "0x58cc3e0aa6cd7bf795832a225179ec2d848ce3e7": "v2.1 ApprovalProxy",
  "0x9ef6d3c2f60d7b9008d74cab1fc0f899c957c819": "v3 Router", "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f": "v3 Router", "0xe16870b028704e38dbc254a84d3f72c8ba345ca9": "v3 Router",
  "0x8754bc615047de01228a7527b712806a71a8dc9a": "v3 ApprovalProxy", "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be": "v3 ApprovalProxy", "0xf6e54bbf91e564fcf0df3ed9f2dd82913e9232c3": "v3 ApprovalProxy",
};
const CURRENT_CONTRACTS = {
  "0x6328ea02d28131e58b28e55c6258258a30d90e05": "v3.2 Router", "0x0729e2a4716d9f7dd17858d5d504426d228697f7": "v3.2 Router",
  "0xe4dfbd5e6784db1058124e2c87554c0591f0fb7b": "v3.2 ApprovalProxy", "0x5567954cd026cebfe486062cb75848e0f1c12e58": "v3.2 ApprovalProxy",
};
const ADDR_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/* ---------- line rules: tested against each line of each file ---------- */
const LINE_RULES = [
  {
    id: "requests-v2", severity: "deadline", deadline: "2026-11-24",
    title: "Uses GET /requests/v2 (or /requests), which Relay retires on 24 Nov 2026",
    test: line => /\/requests\/v2\b/.test(line) || /relay\.link\/requests(?![\/\w])/.test(line),
    why: "v2 has been rate-limited in stages since 1 Sep and its limit was halved on 15 Sep. After 24 Nov it stops working.",
    fix: "Move to GET /requests/v3 with an x-api-key header. Rename inTxs[].hash to txHash, read fees from data.fees, and treat failReason as null instead of \"N/A\".",
    docs: L("/references/api/api_guides/migrating-to-requests-v3"),
  },
  {
    id: "execute-swap-removed", severity: "breaking",
    title: "Calls POST /execute/swap, which was removed on 5 Sep 2026",
    test: line => /\/execute\/swap\b/.test(line),
    why: "The endpoint now returns 404.",
    fix: "Get quotes from POST /quote/v2 and execute the steps it returns.",
    docs: L("/changelog"),
  },
  {
    id: "signature-endpoint-removed", severity: "breaking",
    title: "Calls GET /requests/{id}/signature, which was removed on 1 Sep 2026",
    test: line => /\/requests\/[^\s'"`]*\/signature(\/v2)?\b/.test(line) || /\/signature\/v2\b/.test(line) && /request/i.test(line),
    why: "Both signature endpoints now return 404.",
    fix: "Use includeProtocolData on the quote and the protocol validation guide instead.",
    docs: L("/references/api/api_core_concepts/input-validation"),
  },
  {
    id: "include-protocol-signature", severity: "breaking",
    title: "Sends includeProtocolSignature, renamed to includeProtocolData on 2 Jul 2026",
    test: line => /\bincludeProtocolSignature\b/.test(line),
    why: "The old name is no longer honored, so the protocol data you expect is silently missing.",
    fix: "Rename the flag to includeProtocolData.",
    docs: L("/changelog"),
  },
  {
    id: "fallback-type-removed", severity: "breaking",
    title: "Reads details.fallbackType, removed from quote responses on 12 Oct 2026",
    test: line => /\bfallbackType\b/.test(line),
    why: "The field no longer appears on any response, so code that reads it gets undefined.",
    fix: "Remove the reference.",
    docs: L("/changelog"),
  },
  {
    id: "ignored-liquidity-params", severity: "info",
    title: "Sends useExternalLiquidity or useFallbacks, which Relay ignores since 12 Oct 2026",
    test: line => /\b(useExternalLiquidity|useFallbacks)\b/.test(line),
    why: "Both are accepted but have no effect. Code that relies on them to change routing no longer does anything.",
    fix: "Remove them from your quote requests.",
    docs: L("/changelog"),
  },
  {
    id: "supports-external-liquidity", severity: "warning",
    title: "Branches on supportsExternalLiquidity, which now always returns false",
    test: line => /\bsupportsExternalLiquidity\b/.test(line),
    why: "Deprecated on 12 Oct 2026. Any branch that depends on it is dead code.",
    fix: "Treat it as a constant and remove the branch.",
    docs: L("/changelog"),
  },
  {
    id: "delayed-status", severity: "info",
    title: "Checks for a 'delayed' status, which no longer exists",
    test: line => /['"`]delayed['"`]/.test(line) && /status/i.test(line),
    why: "Current statuses are waiting, depositing, pending, submitted, success, failure and refund.",
    fix: "Handle depositing and submitted instead of delayed.",
    docs: L("/references/api/get-intents-status-v3"),
  },
  {
    id: "old-contract-address", severity: "breaking",
    title: "Hardcodes a Relay contract that was replaced on 26 Oct 2026",
    test: line => (line.match(ADDR_RE) || []).some(a => OLD_CONTRACTS[a.toLowerCase()]),
    detail: line => (line.match(ADDR_RE) || []).filter(a => OLD_CONTRACTS[a.toLowerCase()]).map(a => OLD_CONTRACTS[a.toLowerCase()] + " " + a).join(", "),
    why: "Relay now routes through the v3.2 Router and ApprovalProxy. Approvals to the old proxy don't carry over, and allowlists that only contain old addresses reject new transactions.",
    fix: "Use the transaction targets returned by the quote, or read contracts from Get Chains. If you allowlist, allow both the v3 and v3.2 pairs during the transition.",
    docs: L("/references/api/api_resources/contract-addresses#migrating-to-the-new-router"),
  },
  {
    id: "current-contract-address", severity: "warning",
    title: "Hardcodes a Relay contract address",
    test: line => (line.match(ADDR_RE) || []).some(a => CURRENT_CONTRACTS[a.toLowerCase()]),
    detail: line => (line.match(ADDR_RE) || []).filter(a => CURRENT_CONTRACTS[a.toLowerCase()]).map(a => CURRENT_CONTRACTS[a.toLowerCase()] + " " + a).join(", "),
    why: "Relay has replaced its router several times (v2, v2.1, v3, v3.2). A hardcoded address breaks again at the next migration.",
    fix: "Read transaction targets from the quote, or contracts from Get Chains.",
    docs: L("/references/api/get-chains"),
  },
  {
    id: "slippage-format", severity: "breaking",
    title: "Sends slippageTolerance as a decimal, percentage or negative number",
    test: line => /slippageTolerance\s*["']?\s*[:=]\s*["'`]?\s*(-\d|\d*\.\d|\d+\s*%)/.test(line),
    why: "Since 23 Jun 2026, slippageTolerance must be an integer string from 0 to 10000 basis points. Other values are rejected with 400.",
    fix: "Send basis points as a string: 1% is \"100\", 0.5% is \"50\".",
    docs: L("/changelog"),
  },
  {
    id: "api-key-in-url", fileTest: text => /relay\.link|@relayprotocol|@reservoir0x\/relay/i.test(text), severity: "warning",
    title: "Puts the API key in a URL query string",
    test: line => /[?&]apiKey=/.test(line),
    why: "Keys in URLs end up in logs, proxies and browser history.",
    fix: "Send the key in the x-api-key header, and filter /requests/v3 with apiKeyId instead of apiKey.",
    docs: L("/references/api/api-keys"),
  },
  {
    id: "hardcoded-api-key", fileTest: text => /relay\.link|@relayprotocol|@reservoir0x\/relay/i.test(text), severity: "warning",
    title: "Looks like an API key is hardcoded in source",
    test: line => /x-api-key["'`]?\s*[:=,]\s*["'`](?!your|YOUR|<|\$\{)[A-Za-z0-9_\-]{20,}["'`]/.test(line),
    why: "Anyone with the code can use your App's rate limits and act as your App.",
    fix: "Load the key from an environment variable and keep it server-side. Rotate this key in the Relay Dashboard.",
    docs: L("/references/api/api-keys#keeping-your-api-key-secure"),
  },
  {
    id: "na-string-check", fileTest: text => /\/requests(\/v[23])?[?"'`]|requests\/v[23]\b|getRequests|useRequests/.test(text), severity: "info",
    title: "Compares failReason with \"N/A\"",
    test: line => /(failReason|refundFailReason)[^\n]{0,40}["'`]N\/A["'`]|["'`]N\/A["'`][^\n]{0,40}(failReason|refundFailReason)/.test(line),
    why: "/requests/v3 returns null instead of \"N/A\". This check silently changes meaning when you migrate.",
    fix: "Check for both null and \"N/A\", or only null after moving to v3.",
    docs: L("/references/api/api_guides/migrating-to-requests-v3"),
  },
  {
    id: "v2-response-fields", fileTest: text => /\/requests(\/v[23])?[?"'`]|requests\/v[23]\b|getRequests|useRequests/.test(text), severity: "info",
    title: "Reads v2-only response fields",
    test: line => /\b(expandedPriceImpact|feesUsd|currencyObject|feeCurrencyObject|paidAppFees|subsidizedFee)\b/.test(line),
    why: "These fields are renamed or removed in /requests/v3.",
    fix: "expandedPriceImpact becomes data.fees, metadata moves to data.route, and currencies are single objects. See the field migration table.",
    docs: L("/references/api/api_guides/migrating-to-requests-v3#field-migration-reference"),
  },
  {
    id: "tx-hash-field", fileTest: text => /\/requests(\/v[23])?[?"'`]|requests\/v[23]\b|getRequests|useRequests/.test(text), severity: "info",
    title: "Reads inTxs/outTxs .hash, renamed to .txHash in v3",
    test: line => /\b(inTxs|outTxs)\b[^\n]{0,40}\.hash\b/.test(line),
    why: "On /requests/v3 the field is txHash, so .hash returns undefined.",
    fix: "Read txHash (and fall back to hash while you still call v2).",
    docs: L("/references/api/api_guides/migrating-to-requests-v3"),
  },
  {
    id: "token-price-v1", severity: "deadline", deadline: "2027-01-28",
    title: "Uses GET /currencies/token/price, deprecated from 30 Oct 2026 and retiring on 28 Jan 2027",
    test: line => /\/currencies\/token\/price(?!\/v2)(?![\w\/-])/.test(line),
    why: "Relay replaced it with /currencies/token/price/v2 (changelog, 26 Oct 2026). The v2 response returns price as a decimal string, not a number.",
    fix: "Call GET /currencies/token/price/v2. Parse data.price with Number() where you do arithmetic, and keep the string for display and storage.",
    docs: L("/references/api/get-token-price"),
  },
  {
    id: "config-v2-retiring", severity: "deadline", deadline: "2027-01-28",
    title: "Uses GET /config/v2 (or useRelayConfig / queryRelayConfig), which retires on 28 Jan 2027 with no replacement",
    test: line => /\/config\/v2\b/.test(line) || /\b(useRelayConfig|queryRelayConfig)\b/.test(line),
    why: "The endpoint has no successor, and Relay Hooks 6.0.0 already removed useRelayConfig and queryRelayConfig (changelog, 26 Oct 2026). Upgrading the hooks breaks this code today.",
    fix: "Stop calling the endpoint and remove the code that reads its response.",
    docs: L("/changelog"),
  },
  {
    id: "token-price-number", severity: "info",
    title: "Uses useTokenPrice / queryTokenPrice, whose price became a string in Hooks 6 and UI Kit 12.0.6",
    test: line => /\b(useTokenPrice|queryTokenPrice)\s*(<[^>]*>)?\(/.test(line) && !/function\s+(useTokenPrice|queryTokenPrice)/.test(line),
    why: "From Hooks 6.0.0 and UI Kit 12.0.6, data.price is a decimal string. Multiplying still works, but + joins the text and comparisons compare text, so totals and sorting go wrong quietly.",
    fix: "Wrap data.price in Number() wherever you calculate with it.",
    docs: L("/changelog"),
  },
  {
    id: "old-sdk-package", severity: "warning",
    title: "Uses the old @reservoir0x Relay packages",
    test: line => /@reservoir0x\/relay-(sdk|kit)/.test(line),
    why: "The SDK and UI kit now ship as @relayprotocol packages. The old names don't get fixes for recent API changes.",
    fix: "Switch to @relayprotocol/relay-sdk and @relayprotocol/relay-kit-ui.",
    docs: L("/references/relay-kit/sdk/installation"),
  },
];

/* ---------- repo rules: look at the whole codebase at once ---------- */
const any = (files, re) => files.some(f => re.test(f.text));
const where = (files, re) => { for (const f of files) { const i = f.lines.findIndex(l => re.test(l)); if (i >= 0) return { file: f.path, line: i + 1, text: f.lines[i] }; } return null; };
const RELAY_HINT = /relay\.link|@relayprotocol|@reservoir0x\/relay|relay-sdk|relayClient|getRelayClient/i;

const REPO_RULES = [
  {
    id: "quote-without-api-key", severity: "breaking",
    title: "Calls the quote API without an x-api-key header",
    check: files => {
      const hit = where(files.filter(f => RELAY_HINT.test(f.text)), /relay\.link[^\s'"`]*\/quote(\/v2)?\b|\/quote(\/v2)?["'`?]/);
      if (!hit || !any(files, RELAY_HINT)) return null;
      if (any(files, /x-api-key|RELAY_API_KEY|\bapiKey\s*:/i)) return null;
      return hit;
    },
    why: "Quotes with a referrer need a valid key since 3 Sep 2026 (401 UNAUTHORIZED_QUOTE), and the docs say every /quote/v2 request needs one from 2 Oct 2026.",
    fix: "Create an App and key in the Relay Dashboard and send it in the x-api-key header from your server, or through a proxy if you call from the browser.",
    docs: L("/references/api/api-keys#how-to-use-an-api-key"),
  },
  {
    id: "no-refund-handling", severity: "warning",
    title: "Tracks request status but never handles 'refund'",
    check: files => {
      const hit = where(files, /intents\/status|request\.status\.updated|getExecutionStatus|useExecutionStatus/) || where(files, /\/requests\/v[23]/);
      if (!hit) return null;
      return any(files, /["'`]refund["'`]/) ? null : hit;
    },
    why: "Refunds are a final status. Without handling them, users see a transfer stuck forever while their money is already back (the Phoenix and Atlas-Engine cases).",
    fix: "Treat refund as final: show where the money went (origin chain, possibly a different token) and that it's less the refund gas.",
    docs: L("/references/api/api_core_concepts/refunds"),
  },
  {
    id: "failure-treated-as-final", severity: "warning",
    title: "Treats 'failure' as a final status",
    check: files => { const hits = []; for (const f of files) f.lines.forEach((l, i) => { if (!/refundFailReason/.test(l) && (/\[[^\]\n]*["'`](success|refund)["'`][^\]\n]*["'`]failure["'`][^\]\n]*\]|\[[^\]\n]*["'`]failure["'`][^\]\n]*["'`](success|refund)["'`][^\]\n]*\]/.test(l) || /["'`]failure["'`][^\n]*(clearInterval|clearTimeout|break;|return\b)/.test(l))) hits.push({ file: f.path, line: i + 1, text: l }); }); return hits.length ? hits : null; },
    why: "Only success and refund are final. A failure can be retried back to pending or refunded later. Stopping at failure shows users a wrong result (the polling traps named in Relay's docs).",
    fix: "Keep polling through failure. Stop only on success, refund, or a failure that has refundFailReason set.",
    docs: L("/references/api/get-intents-status-v3"),
  },
  {
    id: "webhook-without-signature", severity: "warning",
    title: "Receives Relay webhooks without verifying the signature",
    check: files => {
      const server = files.filter(f => /request\.status\.updated/.test(f.text) && /app\.(post|use)\(|router\.post\(|export\s+(async\s+)?function\s+POST|NextResponse|req\s*,\s*res|@app\.(route|post)|http\.HandleFunc|webhook/i.test(f.text) && !/new WebSocket|websocket/i.test(f.text));
      const hit = where(server, /request\.status\.updated/);
      if (!hit) return null;
      return any(files, /x-signature-sha256/i) ? null : hit;
    },
    why: "Anyone who finds the endpoint can post fake status updates.",
    fix: "Verify X-Signature-SHA256: HMAC-SHA256 of `${timestamp}.${body}` with your API key. During key rotation, accept both keys.",
    docs: L("/references/api/api_guides/webhooks#verification"),
  },
  {
    id: "strict-deposit-without-refundto", severity: "breaking",
    title: "Creates strict deposit addresses without refundTo",
    check: files => {
      const hit = where(files, /useDepositAddress/);
      if (!hit || !any(files, /\bstrict\b/)) return null;
      return any(files, /refundTo/) ? null : hit;
    },
    why: "refundTo is required for strict deposit addresses. Since 5 Oct 2026, a second deposit to an EXACT_INPUT strict address is refunded to refundTo instead of filling.",
    fix: "Always send refundTo, and tell users each strict address is for one deposit only.",
    docs: L("/features/deposit-addresses#strict-deposit-addresses"),
  },
  {
    id: "fast-polling", severity: "warning",
    title: "Polls Relay faster than once per second",
    check: files => {
      for (const f of files) {
        if (!/relay\.link|intents\/status|requests\/v[23]/.test(f.text)) continue;
        const timers = /set(Interval|Timeout)\(/.test(f.text);
        const i = f.lines.findIndex(l => /set(Interval|Timeout)\([^\n]*,\s*([1-9]\d{0,2})\s*\)/.test(l) || (timers && /^\s*\}\s*,\s*([1-9]\d{0,2})\s*\)\s*;?\s*$/.test(l)) || /(pollInterval|refetchInterval|POLL_MS|interval)\s*[:=]\s*([1-9]\d{0,2})\b/.test(l));
        if (i >= 0) return { file: f.path, line: i + 1, text: f.lines[i] };
      }
      return null;
    },
    why: "Fast polling burns your App's rate limit (200 requests a minute on default keys) and leads to 429s.",
    fix: "Poll every 2 to 5 seconds, or use webhooks or websockets instead.",
    docs: L("/references/api/api_core_concepts/handling-rate-limits"),
  },
  {
    id: "polling-instead-of-webhooks", severity: "info",
    title: "Polls for status without webhooks or websockets",
    check: files => {
      const hit = where(files, /intents\/status/);
      if (!hit) return null;
      return any(files, /webhook|websocket|wss:\/\/|request\.status\.updated/i) ? null : hit;
    },
    why: "Webhooks push every status change with no rate-limit cost and lower latency.",
    fix: "Configure a webhook for your App in the Relay Dashboard.",
    docs: L("/references/api/api_guides/webhooks"),
  },
  {
    id: "outdated-sdk", severity: "info",
    title: "Uses an older major version of the Relay SDK or UI kit",
    check: files => {
      for (const f of files) {
        if (!/package\.json$/.test(f.path)) continue;
        let pkg; try { pkg = JSON.parse(f.text); } catch { continue; }
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        const old = [];
        const major = v => { const m = String(v).match(/(\d+)\./); return m ? Number(m[1]) : null; };
        if (deps["@relayprotocol/relay-sdk"] && major(deps["@relayprotocol/relay-sdk"]) !== null && major(deps["@relayprotocol/relay-sdk"]) < 8) old.push("@relayprotocol/relay-sdk " + deps["@relayprotocol/relay-sdk"] + " (current 8.x)");
        if (deps["@relayprotocol/relay-kit-ui"] && major(deps["@relayprotocol/relay-kit-ui"]) !== null && major(deps["@relayprotocol/relay-kit-ui"]) < 12) old.push("@relayprotocol/relay-kit-ui " + deps["@relayprotocol/relay-kit-ui"] + " (current 12.x)");
        if (old.length) { const i = f.lines.findIndex(l => /@relayprotocol\/relay-(sdk|kit-ui)/.test(l)); return { file: f.path, line: i + 1, text: old.join(", ") }; }
      }
      return null;
    },
    why: "Recent versions fix status handling (success no longer flips to error), deposit-address request IDs, and recipient validation.",
    fix: "Upgrade to the latest SDK 8.x and UI kit 12.x.",
    docs: L("/changelog"),
  },
];

module.exports = { LINE_RULES, REPO_RULES, OLD_CONTRACTS, CURRENT_CONTRACTS };
