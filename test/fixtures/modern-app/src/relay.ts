const RELAY_API = "https://api.relay.link";
const headers = { "Content-Type": "application/json", "x-api-key": process.env.RELAY_API_KEY! };

export async function getQuote(user: string, amount: string) {
  const res = await fetch(`${RELAY_API}/quote/v2`, {
    method: "POST",
    headers,
    body: JSON.stringify({ user, originChainId: 8453, destinationChainId: 42161, amount, tradeType: "EXACT_INPUT", slippageTolerance: "50", refundTo: user }),
  });
  return res.json();
}

export async function history(wallet: string) {
  const r = await fetch(`${RELAY_API}/requests/v3?user=${wallet}`, { headers });
  const { requests } = await r.json();
  return requests.map((q: any) => ({ id: q.id, deposit: q.data.inTxs[0]?.txHash, failed: q.data.failReason != null }));
}

// Only success and refund are final. A failure can still be retried or refunded.
const FINAL = new Set(["success", "refund"]);
export async function pollStatus(requestId: string) {
  for (;;) {
    const r = await fetch(`${RELAY_API}/intents/status/v3?requestId=${requestId}`, { headers });
    const s = await r.json();
    if (FINAL.has(s.status)) return s;
    if (s.status === "failure" && s.refundFailReason) return s; // no automatic refund will follow
    await new Promise(done => setTimeout(done, 3000));
  }
}

export async function usdPrice(chainId: number, address: string) {
  const r = await fetch(`https://api.relay.link/currencies/token/price/v2?chainId=${chainId}&address=${address}`);
  return Number((await r.json()).price);
}
