"use strict";
const api = require("./api");
const { normalize, diagnose, isHash, isAddr } = require("./engine");

/*
 * Finds a request from whatever the customer sent: a request ID, a transaction hash, or a wallet.
 * With an API key it uses /requests/v3 (one search across IDs, hashes and wallets).
 * Without one it uses the public endpoints: /intents/status/v3 and /requests/v2 (until v2 retires on 24 Nov 2026).
 */
async function lookup(input, { apiKey, limit = 10 } = {}) {
  const q = String(input || "").trim();
  if (!isHash(q) && !isAddr(q)) throw new Error("Give a request ID or transaction hash (0x + 64 hex characters), or a wallet address (0x + 40).");
  const notes = [];

  if (apiKey) {
    const { requests } = await api.getRequests({ version: "v3", params: { term: q }, apiKey, max: limit });
    return { requests, source: "requests v3 (search)", notes };
  }

  if (isAddr(q)) {
    try {
      const { requests, deprecation } = await api.getRequests({ version: "v2", params: { user: q }, max: limit });
      if (deprecation) notes.push("Looked up through /requests/v2, which Relay retires on 24 Nov 2026. Pass --api-key to use v3.");
      return { requests, source: "requests v2 (wallet)", notes };
    } catch (e) {
      throw new Error("Wallet lookups without an API key use /requests/v2, which failed: " + e.message + ". Pass --api-key to search with v3.");
    }
  }

  // A 66-character value can be a request ID or a transaction hash.
  // 1) The status API answers request IDs, isn't tightly rate-limited, and returns status "unknown" for anything else.
  let status = null, statusErr = null;
  try { status = await api.getStatus(q); } catch (e) { statusErr = e; }
  const known = status && status.status && status.status !== "unknown";

  // 2) Full details (amounts, fees, timestamps) come from /requests. Without a key that means v2,
  //    which Relay rate-limits hard and retires on 24 Nov 2026, so call it as little as possible.
  let rateLimited = false;
  const v2 = async params => {
    if (rateLimited) return null;
    try { return (await api.getRequests({ version: "v2", params, max: limit })).requests; }
    catch (e) {
      if (e.status === 429) rateLimited = true;
      notes.push(e.status === 429
        ? "Relay's public /requests/v2 is rate-limited right now (it retires on 24 Nov 2026). Pass --api-key to use /requests/v3."
        : "/requests/v2 failed: " + e.message);
      return null;
    }
  };

  if (known) {
    const full = await v2({ id: q });
    if (full && full.length) {
      for (const r of full) if (!["success", "refund"].includes(r.status)) r.status = status.status; // status API is fresher
      return { requests: full, source: "requests v2", notes };
    }
    notes.push("Showing live status only. Amounts and fees need /requests (use --api-key).");
    return { requests: [{ ...status, requestId: q }], source: "status v3", notes };
  }
  if (statusErr && statusErr.status !== 404) notes.push("Status API: " + statusErr.message);

  // Not a request ID the status API knows: treat it as a transaction hash.
  const byHash = await v2({ hash: q });
  if (byHash && byHash.length) return { requests: byHash, source: "requests v2 (by transaction hash)", notes };
  // Could still be a request ID the status API didn't answer for; one more try unless v2 refused us.
  const byId = await v2({ id: q });
  if (byId && byId.length) return { requests: byId, source: "requests v2", notes };
  if (!notes.length) notes.push("Relay has no request with that ID, and no transfer with that transaction hash. Check the value, or ask for the link from the relay.link transaction page.");
  return { requests: [], source: "none", notes };
}

function diagnoseAll(found, now = Date.now()) {
  return found.requests.map(raw => {
    const n = normalize(raw);
    // The API version here is how this tool looked the request up, not what the integrator uses,
    // so don't tell the integrator to migrate off it.
    if (n.source === "requests v2") n.source = "requests v2 (lookup)";
    return { request: n, diagnosis: diagnose(n, now) };
  });
}

module.exports = { lookup, diagnoseAll };
