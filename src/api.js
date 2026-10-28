"use strict";
/* Minimal Relay API client. Uses Node's built-in fetch (Node 18+). No dependencies. */

const IN_NODE = typeof process !== "undefined" && !!(process.versions && process.versions.node);
const BASE = (IN_NODE && process.env.RELAY_API_URL) || "https://api.relay.link";

class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

async function get(path, params = {}, { apiKey, retries = 2 } = {}) {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  // Browsers forbid setting user-agent, and any extra header costs a CORS preflight, so only Node sends it.
  const headers = IN_NODE ? { accept: "application/json", "user-agent": "relay-crosscheck" } : { accept: "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  for (let attempt = 0; ; attempt++) {
    let res;
    try { res = await fetch(url, { headers }); }
    catch (e) {
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      throw new ApiError("Could not reach " + url.host + ": " + ((e.cause && e.cause.code) || e.message), 0, null);
    }
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.ok) return { body, headers: res.headers, url: url.toString() };
    // Retry server errors, and 429s only when Relay says when to come back.
    // /requests/v2 answers 429 with no Retry-After, and retrying it just burns more of the limit.
    const ra = Number(res.headers.get && res.headers.get("retry-after"));
    if (attempt < retries && (res.status >= 500 || (res.status === 429 && ra > 0))) {
      await sleep(ra > 0 ? Math.min(ra, 30) * 1000 : 1500 * (attempt + 1));
      continue;
    }
    const msg = body && typeof body === "object" ? (body.message || body.error || JSON.stringify(body)) : String(body || res.statusText);
    throw new ApiError(res.status + " from " + url.pathname + ": " + msg, res.status, body);
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Pages through a requests endpoint until `max` rows or no continuation. */
async function getRequests({ version = "v3", params = {}, apiKey, max = 1000, onPage } = {}) {
  const out = [];
  let continuation;
  let deprecation = null;
  do {
    const { body } = await get("/requests/" + version, { ...params, limit: Math.min(50, max - out.length), continuation }, { apiKey });
    const rows = (body && body.requests) || [];
    if (body && body.deprecation) deprecation = body.deprecation;
    out.push(...rows);
    continuation = body && body.continuation;
    if (onPage) onPage(out.length);
  } while (continuation && out.length < max);
  return { requests: out, deprecation };
}

const getStatus = (requestId, apiKey) => get("/intents/status/v3", { requestId }, { apiKey }).then(r => r.body);

module.exports = { get, getRequests, getStatus, ApiError, BASE };
