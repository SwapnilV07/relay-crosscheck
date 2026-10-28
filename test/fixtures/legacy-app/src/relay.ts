// Bridge helper written in early 2026
import { createClient } from "@reservoir0x/relay-sdk";

const RELAY_API = "https://api.relay.link";
const RELAY_ROUTER = "0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f"; // allowlisted spender
const APPROVAL_PROXY = "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be";

export async function getQuote(user: string, amount: string) {
  const res = await fetch(`${RELAY_API}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user,
      originChainId: 8453,
      destinationChainId: 42161,
      originCurrency: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      destinationCurrency: "0x0000000000000000000000000000000000000000",
      amount,
      tradeType: "EXACT_INPUT",
      slippageTolerance: "0.5",
      useExternalLiquidity: true,
      includeProtocolSignature: true,
      referrer: "legacy-bridge-app",
    }),
  });
  const quote = await res.json();
  if (quote.details?.fallbackType) console.log("fallback route");
  return quote;
}

export async function history(wallet: string) {
  const r = await fetch(`${RELAY_API}/requests/v2?user=${wallet}&apiKey=sk_live_abc`);
  const { requests } = await r.json();
  return requests.map((q: any) => ({
    id: q.id,
    deposit: q.data.inTxs[0].hash,
    fees: q.data.expandedPriceImpact,
    failed: q.data.failReason !== "N/A",
  }));
}
