"use strict";
/* Relay Crosscheck diagnosis engine: parse -> normalize -> diagnose -> draft.
   Reason codes and meanings come from Relay's "Handling Execution Errors" docs and the API schema. */
const CHAINS = {
  1: ["Ethereum", "https://etherscan.io/tx/"],
  10: ["Optimism", "https://optimistic.etherscan.io/tx/"],
  56: ["BNB Chain", "https://bscscan.com/tx/"],
  130: ["Unichain", "https://uniscan.xyz/tx/"],
  137: ["Polygon", "https://polygonscan.com/tx/"],
  324: ["zkSync Era", "https://explorer.zksync.io/tx/"],
  8453: ["Base", "https://basescan.org/tx/"],
  42161: ["Arbitrum", "https://arbiscan.io/tx/"],
  43114: ["Avalanche", "https://snowtrace.io/tx/"],
  59144: ["Linea", "https://lineascan.build/tx/"],
  81457: ["Blast", "https://blastscan.io/tx/"],
  534352: ["Scroll", "https://scrollscan.com/tx/"],
  7777777: ["Zora", "https://explorer.zora.energy/tx/"],
  792703809: ["Solana", "https://solscan.io/tx/"],
  8253038: ["Bitcoin", "https://mempool.space/tx/"],
};
const chainName = id => (id == null ? "unknown chain" : (CHAINS[id] ? CHAINS[id][0] : "chain " + id));
const explorerName = id => {
  const u = CHAINS[id] && CHAINS[id][1];
  return u ? new URL(u).hostname.replace(/^www\./, "") : "the explorer";
};
const txUrl = (chainId, hash) => (CHAINS[chainId] ? CHAINS[chainId][1] + hash : null);
const relayTxUrl = id => "https://relay.link/transaction/" + id;
const statusApiUrl = id => "https://api.relay.link/intents/status/v3?requestId=" + id;
const requestsByUserUrl = a => "https://api.relay.link/requests/v2?user=" + a;
const requestsByHashUrl = h => "https://api.relay.link/requests/v2?hash=" + h;

/* failReason / refundFailReason reference, grouped from Relay's "Handling Execution Errors" docs.
   cat: user = fix input and requote, transient = retry/requote, escalate = needs Relay review */
const E = (cat, meaning, user, dev) => ({ cat, meaning, user, dev });
const ERRORS = {
  DEPOSIT_ADDRESS_MISMATCH: E("user", "Funds reached a different deposit address than the quote's.", "The funds were sent to a different deposit address than the one this transfer used.", "Deposit landed on a different deposit address than quoted. Show one address per quote and don't reuse old ones."),
  POOL_CAP_EXCEEDED: E("transient", "A liquidity pool's cap was reached.", "There wasn't enough room in the liquidity pool for this amount at that moment.", "Pool cap exceeded. Retry later or reduce the amount."),
  DEPOSIT_CHAIN_MISMATCH: E("user", "Funds reached a strict deposit address on the wrong chain.", "The funds were sent on a different network than the one the quote was for.", "Deposit arrived on a chain other than the quoted origin. Show the origin chain clearly before the user sends to a deposit address."),
  INCORRECT_DEPOSIT_CURRENCY: E("user", "The token received is not the token that was quoted.", "A different token was sent than the one the quote asked for.", "Received currency differs from the quoted origin currency. Validate token address before deposit."),
  DOUBLE_SPEND: E("user", "A second deposit hit an address that was already processed.", "This deposit address had already been used for an earlier transfer.", "Repeat deposit to an already-processed deposit address. Generate a fresh quote per deposit."),
  DEPOSITED_AMOUNT_TOO_LOW_TO_FILL: E("user", "The deposit is below the amount needed to fill.", "Less was sent than the quote required, so the transfer could not be completed.", "Deposit amount below the quoted amount. Make sure the full quoted amount (after token transfer fees) reaches the depository."),
  ORIGIN_CURRENCY_MISMATCH: E("user", "Origin currency differs from the request.", "The token sent does not match the request.", "Origin currency differs from the request. Match currency to the quote."),
  ORPHANED_DEPOSIT_REFUND: E("user", "The deposit matched no fillable request, so it was refunded.", "Your deposit could not be matched to an active order, so it was returned.", "Deposit without a matching request (missing or reused request ID in calldata). Always execute the quote's steps as returned."),
  ORDER_IS_CANCELLED: E("user", "The order was cancelled.", "This order was cancelled before it could complete.", "Order cancelled. Create a new quote."),
  ORDER_ALREADY_FILLED: E("user", "The order was already filled.", "This order had already been completed.", "Order already filled; this is likely a duplicate submission."),
  INVALID_SIGNATURE: E("user", "The signature is invalid.", "The wallet signature could not be verified.", "Invalid signature. Re-sign with the account that requested the quote."),
  INVALID_SIGNER: E("user", "The signer is wrong.", "The transaction was signed by a different wallet than the one that requested it.", "Signer differs from the quote's user. Do not switch accounts between quote and signing."),
  INVALID_SENDER: E("user", "The sender is wrong.", "The transaction came from a different wallet than the one that requested it.", "Sender differs from the quote's user. Re-quote with the sending wallet."),
  INVALID_NONCE: E("user", "The nonce is wrong.", "The transaction was out of order in your wallet.", "Invalid nonce. Rebuild and re-sign."),
  ACCOUNT_ABSTRACTION_SIGNATURE_ERROR: E("user", "The user operation's signature is invalid.", "The smart wallet signature could not be verified.", "Invalid user-operation signature. Re-sign the operation."),
  ZERO_SELL_AMOUNT: E("user", "The input amount is zero.", "The amount sent was zero.", "Zero sell amount. Validate input."),
  INCORRECT_PAYMENT: E("user", "Payment amount is wrong.", "The amount paid did not match what was required.", "Incorrect payment value. Use the quoted value."),
  INSUFFICIENT_NATIVE_TOKENS_SUPPLIED: E("user", "Not enough native token value was supplied.", "Not enough of the network's gas token was included.", "Insufficient msg.value. Send the value the quote returns."),
  TRANSFER_FROM_FAILED: E("user", "The token transfer from the wallet failed (allowance or balance).", "The wallet didn't allow the token to be moved, or didn't hold enough of it.", "transferFrom failed. Check allowance and balance; execute the approve step before the deposit step."),
  TRANSFER_AMOUNT_EXCEEDS_ALLOWANCE: E("user", "The approval was smaller than the amount being sent.", "The token approval you signed was smaller than the amount being sent.", "Allowance below the transfer amount. Execute the approve step from the quote first, and don't reduce the approval amount in the wallet."),
  TRANSFER_AMOUNT_EXCEEDS_BALANCE: E("user", "The wallet balance was too low.", "The wallet didn't hold enough of the token at the time.", "Balance below transfer amount at execution. Re-check balance before submitting."),
  INSUFFICIENT_FUNDS_FOR_RENT: E("user", "The balance can't cover Solana rent.", "Your Solana wallet needs a little more SOL to complete this.", "Insufficient SOL for rent. Add funds or include rent in the amount."),
  NEGATIVE_NEW_AMOUNT_AFTER_FEES: E("user", "Nothing is left after fees.", "The amount was too small to cover the network fees.", "Amount after fees is negative. Enforce a minimum amount."),
  AMOUNT_TOO_LOW_TO_REFUND: E("user", "The refund would be zero or below the chain minimum after gas.", "The amount was too small to cover the cost of sending a refund, so no refund was possible.", "Refundable amount below gas cost or chain minimum. Nothing to refund; consider minimum amounts in your UI."),
  GASLESS_PERMIT_BALANCE_TOO_LOW: E("user", "The permit balance was insufficient, so funds were refunded.", "The approved amount wasn't enough, so the funds were returned.", "Permit amount too low. Use a larger permit."),
  MINT_QUANTITY_EXCEEDS_MAX_PER_WALLET: E("user", "Requested mint quantity breaks the per-wallet limit.", "That's more than this mint allows per wallet.", "Mint quantity over per-wallet max. Reduce quantity."),
  MINT_QUANTITY_EXCEEDS_MAX_SUPPLY: E("user", "Requested mint quantity exceeds remaining supply.", "There weren't enough items left to mint that many.", "Quantity over remaining supply."),
  ERC_1155_TOO_MANY_REQUESTED: E("user", "Too many ERC-1155 tokens requested.", "More items were requested than are available.", "Reduce quantity."),
  TTL_EXPIRED: E("transient", "The quote's time window closed.", "The quote expired before it could be used.", "Quote TTL expired. Requote and execute promptly."),
  ORDER_EXPIRED: E("transient", "The order expired.", "The order expired before it could complete.", "Order expired. Requote."),
  SIGNATURE_EXPIRED: E("transient", "The signature expired.", "The signature expired before it was used.", "Signature expired. Requote and re-sign."),
  PROTOCOL_DEADLINE_EXPIRED: E("transient", "A protocol deadline passed.", "A time limit passed before the transfer completed.", "Protocol deadline expired. Requote."),
  DEPOSIT_CONFIRMATION_TIMEOUT: E("transient", "The deposit wasn't confirmed in time.", "Your deposit took too long to confirm on the network.", "Deposit not confirmed in time. Check the deposit hash; retry with a new deposit if it never landed."),
  DEPOSIT_REORGED: E("transient", "The deposit was removed by a chain reorganization.", "The network reorganized and your deposit was dropped.", "Deposit reorged out. Verify on the explorer and resubmit if needed."),
  SOLVER_CAPACITY_EXCEEDED: E("transient", "The solver lacked capacity for this route.", "There wasn't enough liquidity on this route at that moment.", "Solver capacity exceeded. Retry later or split the amount; check Get Config for capacity."),
  SOLVER_BALANCE_TOO_LOW: E("transient", "The solver's balance was too low.", "There wasn't enough liquidity on this route at that moment.", "Solver balance too low. Retry later or use a smaller amount."),
  SPONSOR_BALANCE_TOO_LOW: E("transient", "The fee sponsor's balance was too low.", "The app sponsoring your fees ran out of balance.", "Sponsor balance too low. Top up the sponsorship balance."),
  NO_QUOTES: E("transient", "No route was available at fill time.", "No route was available at that moment.", "No quotes at fill time. Requote or reduce size."),
  NO_INTERNAL_SWAP_ROUTES_FOUND: E("transient", "No swap route was found.", "No swap route was available at that moment.", "No internal swap routes. Requote or try another token pair."),
  INSUFFICIENT_POOL_LIQUIDITY: E("transient", "Pool liquidity was too thin.", "There wasn't enough liquidity for this token at that moment.", "Insufficient pool liquidity. Reduce size or requote."),
  SWAP_IMPACT_TOO_HIGH: E("transient", "Price impact was beyond tolerance.", "The price moved too much for the swap to go through safely.", "Price impact over limit. Requote; consider a smaller size."),
  SLIPPAGE: E("transient", "The price moved beyond the slippage tolerance.", "The price moved more than your slippage setting allowed, so the swap was stopped to protect you.", "Slippage exceeded. Requote, or raise slippageTolerance for volatile pairs."),
  TOO_LITTLE_RECEIVED: E("transient", "The output would have been below the minimum.", "You would have received less than the minimum, so the swap was stopped to protect you.", "Output below minimum. Requote with adjusted slippage."),
  GENERATE_SWAP_FAILED: E("transient", "Swap generation failed.", "The swap could not be prepared at that moment.", "Swap generation failed. Retry."),
  REVERSE_SWAP_FAILED: E("transient", "Swap reversal failed.", "The swap could not be reversed automatically.", "Reverse swap failed. Retry; escalate if the refund doesn't complete."),
  INVALID_GAS_PRICE: E("transient", "Gas conditions changed.", "Network fees changed while the transfer was in progress.", "Gas price changed. Requote."),
  QUOTED_GAS_LIMIT_EXCEEDED: E("transient", "Gas used would exceed the quoted limit.", "Network fees rose above what was quoted.", "Quoted gas limit exceeded. Requote."),
  NEW_CALLDATA_INCLUDES_HIGHER_RENT_FEE: E("transient", "Solana rent conditions changed.", "Network costs changed while the transfer was in progress.", "Rent fee increased. Requote."),
  TRANSACTION_SUBMISSION_FAILED: E("transient", "The fill was never broadcast, so there's no fill hash.", "The final step didn't reach the network.", "Fill submission failed before broadcast. It may retry; keep polling status."),
  TRANSACTION_NOT_INCLUDED: E("transient", "The fill was broadcast but not included in time.", "The final step was sent but the network didn't include it in time.", "Fill broadcast but not included. Check the recorded hash on the explorer before retrying."),
  ACCOUNT_ABSTRACTION_INVALID_NONCE: E("transient", "The smart-account nonce is stale.", "Your smart wallet's transaction order was out of date.", "Stale AA nonce. Rebuild the user operation."),
  ACCOUNT_ABSTRACTION_GAS_LIMIT: E("transient", "The smart-account gas limit was exceeded.", "Your smart wallet ran out of gas allowance.", "AA gas limit exceeded. Rebuild with a higher limit."),
  MINT_NOT_ACTIVE: E("transient", "The mint phase isn't open.", "The mint wasn't open yet.", "Mint not active. Retry when the phase opens."),
  BLOCKED_WALLET: E("escalate", "A wallet failed compliance screening. Funds are not refunded automatically.", "This transfer needs a manual review by our team before anything else can happen.", "Address failed screening (BLOCKED_WALLET). Funds aren't auto-refunded; Support reviews it. With v3 + includeAuthenticatedData you can see data.blockedAddresses."),
  MANUAL_ADMIN_REFUND: E("escalate", "Relay refunded this manually.", "Our team refunded this transfer manually.", "Manual admin refund was issued. Confirm with Relay if unexpected."),
  UNKNOWN: E("escalate", "No known failure pattern matched.", "Something unexpected happened and our team needs to look at it.", "Unknown failure. Escalated with full request details."),
  EXECUTION_REVERTED: E("escalate", "The on-chain call reverted.", "The final step was rejected on-chain.", "Execution reverted. Pull failedTxHash / failedCallData and simulate (e.g. Tenderly) to find the revert reason."),
  TRANSACTION_REVERTED: E("escalate", "The fill transaction reverted on-chain.", "The final step was rejected on-chain.", "Fill reverted. Pull failedTxHash / failedCallData from the requests API and simulate to find the revert reason."),
  MISSING_REVERT_DATA: E("escalate", "The call reverted with no reason given.", "The final step was rejected on-chain without a reason.", "Revert with no data. Simulate failedCallData to locate it."),
  CONTRACT_PAUSED: E("escalate", "The target contract is paused.", "The destination contract is paused right now.", "Target contract paused. Wait for unpause or escalate."),
  TOKEN_NOT_TRANSFERABLE: E("escalate", "The token blocks transfers.", "This token can't be transferred this way.", "Token not transferable (soulbound, tax, or blacklist). Escalate with token details."),
  DESTINATION_TOKEN_TRANSFER_REJECTED: E("escalate", "The destination token rejected the transfer.", "The destination token refused the transfer.", "Destination token rejected transfer. Escalate with token details."),
  TRANSFER_FAILED: E("escalate", "The token transfer failed.", "The token transfer failed.", "Transfer failed. Escalate with token details."),
  SWAP_USES_TOO_MUCH_GAS: E("escalate", "The swap exceeds gas limits.", "This swap is too large for the network to process in one step.", "Swap gas over limit. Escalate."),
  TRANSACTION_TOO_LARGE: E("escalate", "The transaction exceeds payload limits.", "This transaction is too large for the network to process.", "Transaction too large. Escalate."),
  JUPITER_INVALID_TOKEN_ACCOUNT: E("escalate", "Solana token account error (Jupiter).", "There's a problem with the Solana token account.", "Jupiter invalid token account. Escalate."),
  FLUID_DEX_ERROR: E("escalate", "Fluid DEX error.", "The swap venue returned an error.", "Fluid DEX error. Escalate."),
  SEAPORT_INEXACT_FRACTION: E("escalate", "The Seaport order can't be filled as specified.", "This marketplace order couldn't be filled as requested.", "Seaport inexact fraction. Escalate."),
  SEAPORT_INVALID_FULFILLER: E("escalate", "The Seaport fulfiller is invalid.", "This marketplace order couldn't be filled as requested.", "Seaport invalid fulfiller. Escalate."),
  SWAP_CURRENCY_NOT_ON_ORIGIN: E("escalate", "The refund can't go back in the original currency.", "The refund can't be sent back in the original token automatically.", "Refund currency not available on origin. Escalate."),
  REFUND_RECIPIENT_IS_VASP: E("escalate", "The refund recipient is an exchange or custodian and needs manual review.", "Your refund address belongs to an exchange, so the refund needs a manual review.", "Refund recipient is a VASP. Manual review required."),
  REFUND_RECIPIENT_IS_BLOCKED: E("escalate", "The refund recipient failed screening.", "The refund needs a manual review by our team.", "Refund recipient blocked. Manual review required."),
  MANUAL_REFUND_REQUIRED: E("escalate", "An automatic refund isn't possible; it must be done manually.", "Your refund needs to be processed manually by our team.", "Automatic refund not possible. Escalate for manual refund."),
};

/* Likely owner of each fail reason: who can fix it. This is a support heuristic, not an official Relay classification. */
const OWNER_GROUPS = {
  integrator: ["SPONSOR_BALANCE_TOO_LOW","GASLESS_PERMIT_BALANCE_TOO_LOW","TTL_EXPIRED","SIGNATURE_EXPIRED","ORDER_EXPIRED","PROTOCOL_DEADLINE_EXPIRED","INVALID_SIGNATURE","INVALID_SIGNER","INVALID_SENDER","INVALID_NONCE","ACCOUNT_ABSTRACTION_INVALID_NONCE","ACCOUNT_ABSTRACTION_SIGNATURE_ERROR","ACCOUNT_ABSTRACTION_GAS_LIMIT","TRANSFER_AMOUNT_EXCEEDS_ALLOWANCE","TRANSFER_FROM_FAILED","INSUFFICIENT_NATIVE_TOKENS_SUPPLIED","INCORRECT_PAYMENT","ZERO_SELL_AMOUNT","ORPHANED_DEPOSIT_REFUND","ORIGIN_CURRENCY_MISMATCH","ORDER_IS_CANCELLED","ORDER_ALREADY_FILLED"],
  user: ["DEPOSIT_CHAIN_MISMATCH","DEPOSIT_ADDRESS_MISMATCH","INCORRECT_DEPOSIT_CURRENCY","DOUBLE_SPEND","DEPOSITED_AMOUNT_TOO_LOW_TO_FILL","TRANSFER_AMOUNT_EXCEEDS_BALANCE","INSUFFICIENT_FUNDS_FOR_RENT","NEGATIVE_NEW_AMOUNT_AFTER_FEES","AMOUNT_TOO_LOW_TO_REFUND","BLOCKED_WALLET","REFUND_RECIPIENT_IS_VASP","REFUND_RECIPIENT_IS_BLOCKED","MINT_QUANTITY_EXCEEDS_MAX_PER_WALLET","MINT_QUANTITY_EXCEEDS_MAX_SUPPLY","ERC_1155_TOO_MANY_REQUESTED"],
  market: ["SLIPPAGE","TOO_LITTLE_RECEIVED","SWAP_IMPACT_TOO_HIGH","INSUFFICIENT_POOL_LIQUIDITY","POOL_CAP_EXCEEDED","NO_INTERNAL_SWAP_ROUTES_FOUND","NO_QUOTES","INVALID_GAS_PRICE","QUOTED_GAS_LIMIT_EXCEEDED","NEW_CALLDATA_INCLUDES_HIGHER_RENT_FEE"],
  relay: ["SOLVER_CAPACITY_EXCEEDED","SOLVER_BALANCE_TOO_LOW","GENERATE_SWAP_FAILED","REVERSE_SWAP_FAILED","TRANSACTION_SUBMISSION_FAILED","TRANSACTION_NOT_INCLUDED","EXECUTION_REVERTED","TRANSACTION_REVERTED","MISSING_REVERT_DATA","UNKNOWN","MANUAL_ADMIN_REFUND","SWAP_USES_TOO_MUCH_GAS","TRANSACTION_TOO_LARGE","SWAP_CURRENCY_NOT_ON_ORIGIN","MANUAL_REFUND_REQUIRED"],
  token_or_chain: ["TOKEN_NOT_TRANSFERABLE","DESTINATION_TOKEN_TRANSFER_REJECTED","TRANSFER_FAILED","CONTRACT_PAUSED","DEPOSIT_REORGED","DEPOSIT_CONFIRMATION_TIMEOUT","JUPITER_INVALID_TOKEN_ACCOUNT","FLUID_DEX_ERROR","SEAPORT_INEXACT_FRACTION","SEAPORT_INVALID_FULFILLER","MINT_NOT_ACTIVE"],
};
const OWNER = {};
for (const [o, codes] of Object.entries(OWNER_GROUPS)) for (const c of codes) OWNER[c] = o;
const OWNER_LABEL = { integrator: "Integrator", user: "End user", market: "Market conditions", relay: "Relay", token_or_chain: "Token or chain", unknown: "Unknown" };
const ownerOf = code => (code && OWNER[code]) || "unknown";
const errInfo = code => (code && ERRORS[code]) || (code ? E("escalate", "This code isn't in the reference table yet.", "Our team needs to take a closer look at this transfer.", "Unrecognised code " + code + ". Check the latest Execution Errors docs.") : null);

/* ---------- helpers ---------- */
const isHash = s => /^0x[0-9a-fA-F]{64}$/.test(s);
const isAddr = s => /^0x[0-9a-fA-F]{40}$/.test(s);
const toMs = t => { if (t == null || t === "") return null; if (typeof t === "string" && !/^\d+$/.test(t)) { const d = Date.parse(t); return isNaN(d) ? null : d; } const n = Number(t); return n > 1e12 ? n : n * 1000; };
const num = v => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
const NULLISH = v => v == null || v === "N/A" || v === "";
const clean = v => (NULLISH(v) ? null : v);
const short = h => (h && h.length > 14 ? h.slice(0, 8) + "…" + h.slice(-6) : h || "");
const fmtUsd = v => (v == null ? "—" : (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(Math.abs(v) < 0.01 && v !== 0 ? 4 : 2));
const fmtAmt = a => (a ? trimNum(a.amount) + " " + a.symbol : "—");
function trimNum(s) { const n = Number(s); if (!isFinite(n)) return String(s); if (n === 0) return "0"; if (Math.abs(n) >= 1) return String(+n.toFixed(6)); return String(+n.toPrecision(6)); }
const fmtUtc = ms => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");
function fmtDur(sec) { if (sec == null) return "—"; sec = Math.round(sec); if (sec < 1) return "under 1s"; if (sec < 60) return sec + "s"; const m = Math.floor(sec / 60); if (m < 60) return m + "m " + (sec % 60) + "s"; const h = Math.floor(m / 60); if (h < 48) return h + "h " + (m % 60) + "m"; return Math.floor(h / 24) + "d " + (h % 24) + "h"; }
function findKey(obj, re, depth = 0) { if (!obj || typeof obj !== "object" || depth > 6) return null; for (const k of Object.keys(obj)) { if (re.test(k)) return obj[k]; } for (const k of Object.keys(obj)) { const r = findKey(obj[k], re, depth + 1); if (r) return r; } return null; }
function amountFrom(a) { if (!a) return null; const c = a.currency || {}; return { amount: a.amountFormatted != null ? a.amountFormatted : a.amount, symbol: c.symbol || "?", usd: num(a.amountUsd), chainId: c.chainId != null ? Number(c.chainId) : null, address: c.address || null }; }
function feeSet(o) { if (!o) return null; const out = {}; for (const k of Object.keys(o)) { const v = o[k] && typeof o[k] === "object" ? num(o[k].usd) : null; if (v != null) out[k === "relay" ? "platform" : k] = v; } return out; }
const sum = o => (o ? Object.values(o).reduce((a, b) => a + b, 0) : null);

/* ---------- parse & normalize ---------- */
function parseInput(text) {
  const t = (text || "").trim();
  if (!t) throw new Error("Paste JSON from the Relay API or transaction page first.");
  if (isHash(t) || isAddr(t)) { const e = new Error("LOOKUP"); e.lookup = t; throw e; }
  let raw;
  try { raw = JSON.parse(t); } catch (e) { throw new Error("That isn't valid JSON. Copy the whole response, from the first { to the last }."); }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw.requests) ? raw.requests : [raw];
  if (!list.length) throw new Error("The response has no requests in it. Check the wallet address or hash you searched for.");
  const out = list.map(normalize);
  return { requests: out, deprecation: raw && raw.deprecation ? raw.deprecation : null };
}

function normalize(r) {
  if (r && "inTxHashes" in r || (r && "txHashes" in r && !r.data)) return normalizeStatus(r);
  if (!r || !r.data || !r.id) throw new Error("This JSON doesn't look like a Relay request. Use /requests, /intents/status/v3, or the transaction page data.");
  const d = r.data;
  const v3 = !!(d.route || (d.fees && d.fees.quoted) || (d.inTxs && d.inTxs[0] && "txHash" in d.inTxs[0]));
  const tx = t => ({ hash: t.txHash || t.hash, chainId: t.chainId != null ? Number(t.chainId) : null, ts: toMs(t.timestamp), status: t.status || null, fee: t.fee || null });
  const inTxs = (d.inTxs || []).map(tx);
  const outTxs = (d.outTxs || []).map(tx);
  let amountIn, amountOut, gasTopup, fees, rate;
  if (v3) {
    const rt = d.route || {}; const ph = rt.actual || rt.quoted || {};
    amountIn = amountFrom(ph.origin && ph.origin.inputCurrency);
    amountOut = amountFrom((ph.destination && ph.destination.outputCurrency) || (ph.origin && ph.origin.outputCurrency));
    gasTopup = amountFrom(findKey(rt, /gastopup/i));
    fees = { quoted: feeSet(d.fees && d.fees.quoted), actual: feeSet(d.fees && d.fees.actual) };
    rate = ph.rate || null;
  } else {
    const m = d.metadata || {};
    amountIn = amountFrom(m.currencyIn); amountOut = amountFrom(m.currencyOut); gasTopup = amountFrom(m.currencyGasTopup);
    fees = { quoted: feeSet(d.expandedPriceImpact && d.expandedPriceImpact.quoted), actual: feeSet(d.expandedPriceImpact && d.expandedPriceImpact.actual) };
    rate = m.rate || null;
  }
  const settle = r.protocol && r.protocol.settlement && r.protocol.settlement.destination;
  const refunds = (settle && settle.refunds || []).map(x => ({ hash: x.transactionId, chainId: Number(x.chainId) }));
  const originChainId = (inTxs[0] && inTxs[0].chainId) || (amountIn && amountIn.chainId) || null;
  const destChainId = (amountOut && amountOut.chainId) || (outTxs[0] && outTxs[0].chainId) || null;
  const sender = r.sender || (d.metadata && d.metadata.sender) || r.user || null;
  return {
    source: v3 ? "requests v3" : "requests v2", id: r.id, status: r.status, requestType: r.requestType || null,
    user: r.user || null, sender, recipient: r.recipient || null,
    createdAt: toMs(r.createdAt), updatedAt: toMs(r.updatedAt), quoteCreatedAt: null,
    originChainId, destChainId, inTxs, outTxs, refunds,
    failReason: clean(d.failReason), refundFailReason: clean(d.refundFailReason),
    failedTxHash: clean(d.failedTxHash), failedCallData: clean(d.failedCallData),
    amountIn, amountOut, gasTopup, fees, rate,
    slippageBps: num(d.slippageTolerance), timeEstimate: num(d.timeEstimate),
    depositAddress: r.depositAddress ? (typeof r.depositAddress === "string" ? r.depositAddress : r.depositAddress.address) : null,
    features: r.features || null,
  };
}

function normalizeStatus(r) {
  const o = r.originChainId != null ? Number(r.originChainId) : null, dc = r.destinationChainId != null ? Number(r.destinationChainId) : null;
  const outChain = r.status === "refund" ? o : dc;
  return {
    source: "status v3", id: r.requestId || r.id || null, status: r.status, requestType: null,
    user: null, sender: null, recipient: null,
    createdAt: toMs(r.quoteCreatedAt), updatedAt: toMs(r.updatedAt), quoteCreatedAt: toMs(r.quoteCreatedAt),
    originChainId: o, destChainId: dc,
    inTxs: (r.inTxHashes || []).map(h => ({ hash: h, chainId: o, ts: null })),
    outTxs: (r.txHashes || []).map(h => ({ hash: h, chainId: outChain, ts: null })),
    refunds: [], failReason: clean(r.failReason), refundFailReason: clean(r.refundFailReason),
    failedTxHash: null, failedCallData: null, amountIn: null, amountOut: null, gasTopup: null, fees: { quoted: null, actual: null },
    rate: null, slippageBps: null, timeEstimate: null, depositAddress: null, features: null, details: r.details || null,
  };
}

/* ---------- where the cost went ----------
   Relay splits every request's cost into execution, swap, platform (called "relay" in v2) and app,
   plus what the integrator sponsored. Negative values are costs to the user. Source: docs "Cost & Fee Structure". */
const COST_PARTS = [
  ["execution", "Network gas", "Gas to deliver the funds on the destination chain, plus Relay's small flat execution fee"],
  ["swap", "Swap cost", "DEX fees, price impact and solver rebalancing when tokens are converted"],
  ["platform", "Relay platform fee", "Relay's own fee: 0% for a plain bridge, 0.01% for stablecoin swaps, 0.06% for major tokens, 0.15% for other tokens"],
  ["app", "App fee", "Added by the app or wallet the user transferred through; Relay doesn't set or keep it"],
];
function costBreakdown(n) {
  const has = o => o && Object.keys(o).length;
  const src = has(n.fees.actual) ? n.fees.actual : has(n.fees.quoted) ? n.fees.quoted : null;
  if (!src) return null;
  const parts = COST_PARTS.map(([key, label, what]) => ({ key, label, what, usd: Math.max(0, -(src[key] || 0)) }));
  // A gas top-up is delivered to the user but Relay counts it inside a fee line (execution on the quote,
  // sometimes swap on the actual). Take it out of whichever line holds it, so it isn't blamed as a cost.
  const top = n.gasTopup && n.gasTopup.usd > 0 ? n.gasTopup.usd : 0;
  let gasTopup = 0;
  if (top) {
    const holder = parts.slice().sort((x, y) => y.usd - x.usd)[0];
    if (holder.usd >= top * 0.9) { holder.usd = Math.max(0, holder.usd - top); gasTopup = top; }
  }
  const gross = parts.reduce((a, p) => a + p.usd, 0);
  const sponsored = Math.max(0, src.sponsored || 0);
  parts.forEach(p => { p.share = gross ? p.usd / gross : 0; });
  const main = gross > 0 ? parts.slice().sort((a, b) => b.usd - a.usd)[0] : null;
  return { phase: src === n.fees.actual ? "actual" : "quoted", parts, gross, sponsored, gasTopup, userPays: Math.max(0, gross - sponsored), main };
}
/* Plain-English reason for the cost: { agent, user }. */
function costReason(cb, n) {
  if (!cb || !cb.main) return null;
  const m = cb.main, pc = Math.round(m.share * 100) + "%";
  const dest = chainName(n.destChainId);
  const valIn = n.amountIn && n.amountIn.usd;
  const small = valIn != null && valIn < 50 && cb.userPays / valIn > 0.01;
  const sameToken = n.amountIn && n.amountOut && n.amountIn.symbol === n.amountOut.symbol;
  const pair = n.amountIn && n.amountOut ? n.amountIn.symbol + " to " + n.amountOut.symbol : "the tokens";
  let agent, user;
  if (m.key === "app") {
    agent = "Mostly the app's own fee (" + fmtUsd(m.usd) + ", " + pc + "). The integrator sets it; Relay doesn't receive it. Point fee questions about it to the app.";
    user = "Most of that (" + fmtUsd(m.usd) + ") is the fee charged by the app or wallet you used. That fee is set by the app, not by Relay.";
  } else if (m.key === "execution") {
    agent = "Mostly network gas on " + dest + " plus the flat execution fee (" + fmtUsd(m.usd) + ", " + pc + "). Gas costs about the same for any amount" + (small ? ", so it's a big share of a small transfer like this one." : ".") + (n.destChainId === 1 ? " Ethereum mainnet gas is the most expensive of any chain." : "");
    user = "Most of that (" + fmtUsd(m.usd) + ") is the network fee for delivering your funds on " + dest + ". It costs about the same whatever the amount" + (small ? ", so on a small transfer it's a bigger share." : ".") + (n.destChainId === 1 ? " Ethereum's network fees are the highest of any chain, so sending to a lower-cost network such as Base or Arbitrum costs less." : "");
  } else if (m.key === "swap" && sameToken) {
    agent = "Mostly the cross-chain cost of moving " + n.amountIn.symbol + " (" + fmtUsd(m.usd) + ", " + pc + "): solver rebalancing and liquidity between networks. Larger amounts and less-used routes cost more.";
    user = "Most of that (" + fmtUsd(m.usd) + ") is the cost of moving " + n.amountIn.symbol + " from one network to another.";
  } else if (m.key === "swap") {
    agent = "Mostly swap cost converting " + pair + " (" + fmtUsd(m.usd) + ", " + pc + "): DEX fees and price impact. It grows with the amount and with less liquid tokens, and actual can differ from the quote within the slippage allowed.";
    user = "Most of that (" + fmtUsd(m.usd) + ") is the cost of converting " + pair + ": exchange fees and the price movement while swapping.";
  } else {
    agent = "Mostly Relay's platform fee (" + fmtUsd(m.usd) + ", " + pc + "), which depends on the token pair (0% to 0.15%).";
    user = "Most of that (" + fmtUsd(m.usd) + ") is Relay's service fee, which is between 0% and 0.15% depending on the tokens.";
  }
  if (cb.gasTopup) agent += " The " + fmtUsd(cb.gasTopup) + " gas top-up is excluded: the user received it.";
  if (cb.sponsored > 0) { agent += " The integrator sponsored " + fmtUsd(cb.sponsored) + " of the fees."; user += " The app also covered " + fmtUsd(cb.sponsored) + " of the fees for you."; }
  return { agent, user };
}

/* ---------- diagnose ---------- */
const STATUS_TEXT = {
  waiting: "Waiting for the deposit", depositing: "Deposit seen, fill not started", pending: "Fill in progress",
  submitted: "Fill sent on destination", success: "Delivered", failure: "Fill failed", refund: "Refunded", delayed: "Delayed",
};

function diagnose(n, nowMs) {
  nowMs = nowMs || Date.now();
  const F = []; // findings {tone: ok|info|warn|bad, label, detail}
  const route = routeText(n);
  const dep = n.inTxs[0], fill = n.outTxs[0];
  const fillSec = dep && fill && dep.ts && fill.ts ? (fill.ts - dep.ts) / 1000 : null;
  const lastMs = n.updatedAt || n.createdAt;
  const ageSec = lastMs ? (nowMs - (n.createdAt || lastMs)) / 1000 : null;
  const idleSec = lastMs ? (nowMs - lastMs) / 1000 : null;
  const err = errInfo(n.failReason), rerr = errInfo(n.refundFailReason);
  const fq = n.fees.quoted, fa = n.fees.actual;
  const totQ = sum(fq), totA = sum(fa);
  const topUsd = n.gasTopup && n.gasTopup.usd;

  // facts every status shares
  if (n.inTxs.length) F.push({ tone: "ok", label: "Deposit found", detail: n.inTxs.length + " deposit transaction" + (n.inTxs.length > 1 ? "s" : "") + " on " + chainName(dep.chainId) + "." });
  else if (n.status !== "waiting") F.push({ tone: "info", label: "No deposit recorded", detail: "Relay hasn't recorded a deposit transaction for this request." });
  if (n.inTxs.length > 1) F.push({ tone: "warn", label: "More than one deposit", detail: "Multiple deposits on one request can lead to a refund of the extra deposit. Check each hash." });
  if (n.recipient && n.sender && n.recipient.toLowerCase() !== n.sender.toLowerCase())
    F.push({ tone: "warn", label: "Recipient is a different wallet", detail: "Funds go to " + n.recipient + ", not the sending wallet " + short(n.sender) + ". Users often look in the wrong wallet." });
  if (n.depositAddress) F.push({ tone: "info", label: "Deposit-address flow", detail: "User sent to deposit address " + short(n.depositAddress) + " without connecting a wallet. Wrong chain or wrong token are the common mistakes here." });
  if (topUsd) F.push({ tone: "info", label: "Includes a gas top-up", detail: "About " + fmtUsd(topUsd) + " was delivered as " + fmtAmt(n.gasTopup) + " on " + chainName(n.gasTopup.chainId || n.destChainId) + ". It appears inside the costs but the user received it." });
  const valIn = n.amountIn && n.amountIn.usd, valOut = n.amountOut && n.amountOut.usd;
  const userCost = n.status === "success" && valIn != null && valOut != null ? valIn - valOut - (topUsd || 0) : null;
  if (userCost != null) F.push({ tone: userCost / valIn > 0.03 ? "warn" : "ok", label: "Total cost " + fmtUsd(userCost) + " (" + (userCost / valIn * 100).toFixed(2) + "%)", detail: "Sent " + fmtUsd(valIn) + ", received " + fmtUsd(valOut) + (topUsd ? " plus " + fmtUsd(topUsd) + " of gas" : "") + ". This covers swap, gas and Relay fees together." });
  const cost = n.status === "success" ? costBreakdown(n) : null;
  const reason = costReason(cost, n);
  if (cost && cost.gross > 0) {
    const appHeavy = cost.main && cost.main.key === "app" && userCost != null && valIn && userCost / valIn > 0.03;
    F.push({ tone: appHeavy ? "warn" : "info", label: "Where the cost went", detail: cost.parts.filter(p => p.usd > 0.00005).map(p => p.label + " " + fmtUsd(p.usd)).join(" · ") + (cost.sponsored ? " · Paid by the app " + fmtUsd(cost.sponsored) : "") + ". " + (reason ? reason.agent : "") });
  }
  if (n.status === "success" && totQ != null && totA != null) {
    const shifted = fq && fa && Object.keys({ ...fq, ...fa }).some(k => Math.abs((fq[k] || 0) - (fa[k] || 0)) > 0.25);
    const same = Math.abs(totQ - totA) <= Math.max(0.02, Math.abs(totQ) * 0.02);
    if (shifted && same) F.push({ tone: "info", label: "Costs moved between categories", detail: "Quoted and actual totals match (" + fmtUsd(totQ) + " vs " + fmtUsd(totA) + "), but the split between swap and execution changed. Compare totals, not lines." });
    else if (!same) F.push({ tone: Math.abs(totA) > Math.abs(totQ) ? "warn" : "ok", label: "Actual cost differs from quote", detail: "Quoted " + fmtUsd(totQ) + ", actual " + fmtUsd(totA) + "." });
  }
  if (n.source === "requests v2") F.push({ tone: "info", label: "Old API version", detail: "This came from /requests/v2, which Relay retires on 24 Nov 2026. Integrators should move to /requests/v3 (txHash, data.fees, x-api-key required)." });

  let sev = "info", headline = STATUS_TEXT[n.status] || ("Status: " + n.status), summary = "", escalate = false, why = "", checks = [], ask = "";
  const est = n.timeEstimate;

  switch (n.status) {
    case "success": {
      sev = "ok";
      summary = "Relay delivered " + fmtAmt(n.amountOut) + " on " + chainName(n.destChainId) + (fillSec != null ? (fillSec < 2 ? ", within a second or two of the deposit" : ", " + fmtDur(fillSec) + " after the deposit") : "") + ".";
      if (fillSec != null) F.unshift({ tone: est && fillSec > est * 20 && fillSec > 120 ? "warn" : "ok", label: "Fill time " + fmtDur(fillSec), detail: est ? "Quote estimated about " + est + "s." : "Measured from deposit to fill." });
      if (fill) F.unshift({ tone: "ok", label: "Fill confirmed", detail: "Fill transaction " + short(fill.hash) + " on " + chainName(fill.chainId) + "." });
      checks = ["If the user says funds are missing: confirm they're looking at " + chainName(n.destChainId) + " in their wallet", "Confirm the recipient address matches their wallet", "If the token doesn't show, they may need to add it to their wallet"];
      break;
    }
    case "refund": {
      sev = "warn";
      summary = "The fill didn't happen, and the deposit was refunded on " + chainName(n.originChainId) + (err ? ", because: " + err.meaning.toLowerCase() : ".");
      if (err) F.unshift({ tone: "warn", label: "Fail reason: " + n.failReason, detail: err.meaning });
      F.unshift({ tone: "ok", label: "Refund sent on the origin chain", detail: "Refunds go back to " + chainName(n.originChainId) + ", not to " + chainName(n.destChainId) + ". The amount is lower than the deposit because refund gas is deducted, and any origin swap is returned in the swapped token." });
      if (n.failReason === "MANUAL_ADMIN_REFUND") escalate = false;
      checks = ["Show the user the refund transaction on " + explorerName(n.originChainId), "Explain why the refund is smaller than the deposit", "Suggest a fresh quote if the cause was temporary"];
      break;
    }
    case "failure": {
      sev = "bad";
      summary = "The fill failed" + (err ? " (" + n.failReason + ")" : "") + " and no refund has completed yet.";
      if (err) F.unshift({ tone: err.cat === "escalate" ? "bad" : "warn", label: "Fail reason: " + n.failReason, detail: err.meaning });
      if (rerr) F.unshift({ tone: "bad", label: "Automatic refund blocked: " + n.refundFailReason, detail: rerr.meaning });
      if (n.failedTxHash) F.push({ tone: "info", label: "Failed transaction recorded", detail: short(n.failedTxHash) + ". Simulate failedCallData to see the revert reason." });
      if (rerr || (err && err.cat === "escalate") || (idleSec != null && idleSec > 1800)) {
        escalate = true;
        why = rerr ? "Refund can't happen automatically (" + n.refundFailReason + ")." : err && err.cat === "escalate" ? n.failReason + " needs Relay review." : "Failure hasn't moved for " + fmtDur(idleSec) + ".";
      } else {
        why = "";
        F.push({ tone: "info", label: "Not final yet", detail: "A failure can still move to pending (retry) or refund. Keep checking unless refundFailReason appears." });
      }
      checks = ["Check status again in a few minutes", "Look up the deposit on " + explorerName(n.originChainId), rerr ? "Escalate: automatic refund won't happen" : "If it stays failed for 30+ minutes, escalate"];
      break;
    }
    case "waiting": {
      sev = idleSec != null && idleSec > 900 ? "warn" : "info";
      summary = "Relay hasn't seen a deposit for this request" + (idleSec != null ? " (" + fmtDur(idleSec) + " since the quote)" : "") + ".";
      checks = ["Ask the user for the transaction hash from their wallet", "Check that hash on the origin explorer: did it succeed, and on which chain?", "If they sent to a deposit address, confirm the chain and token match the quote"];
      if (idleSec != null && idleSec > 900) F.unshift({ tone: "warn", label: "No deposit after " + fmtDur(idleSec), detail: "Usually the user never sent it, the wallet transaction failed, or they sent from a different wallet or chain." });
      break;
    }
    case "depositing": case "pending": case "submitted": case "delayed": {
      const slow = idleSec != null && idleSec > 600;
      sev = slow ? "bad" : "info";
      summary = (n.status === "submitted" ? "The fill was sent on " + chainName(n.destChainId) + " and is waiting to confirm." : n.status === "depositing" ? "The deposit is confirmed and the fill hasn't started yet." : "The fill is in progress.") + (idleSec != null ? " Last update " + fmtDur(idleSec) + " ago." : "");
      if (slow) { escalate = true; why = "Request has been " + n.status + " for " + fmtDur(idleSec) + "; normal fills take seconds."; F.unshift({ tone: "bad", label: "Stuck for " + fmtDur(idleSec), detail: "Normal fills complete in seconds to a couple of minutes." }); }
      if (n.status === "submitted" && fill) F.push({ tone: "info", label: "Fill hash available", detail: "Check " + short(fill.hash) + " on " + explorerName(fill.chainId) + " for its on-chain state." });
      checks = slow ? ["Check the fill hash (if any) on the destination explorer", "Check whether the destination chain is congested or down", "Escalate with this note"] : ["Ask the user to wait a few minutes", "Check status again before replying"];
      break;
    }
    default: summary = "Status '" + n.status + "' isn't one this tool knows. Treat it as needing a closer look.";
  }
  if (err && n.status !== "success" && err.cat === "escalate") { escalate = true; why = why || n.failReason + " needs Relay review."; }
  if (escalate) sev = "bad";

  const ctx = { n, route, err, rerr, fillSec, idleSec, ageSec, escalate, why, userCost, cost, reason };
  return {
    sev, headline, summary, findings: F, checks, escalate,
    userReply: draftUser(ctx), devReply: draftDev(ctx), escalation: escalate ? draftEscalation(ctx, checks) : null,
    timeline: timeline(n), money: money(n, totQ, totA), cost, costReason: reason,
  };
}

function routeText(n) {
  const a = n.amountIn ? fmtAmt(n.amountIn) + " on " : "";
  const b = n.amountOut ? fmtAmt(n.amountOut) + " on " : "";
  return a + chainName(n.originChainId) + " → " + b + chainName(n.destChainId);
}

function timeline(n) {
  const T = [];
  if (n.quoteCreatedAt || n.createdAt) T.push({ label: "Request created", ts: n.quoteCreatedAt || n.createdAt });
  n.inTxs.forEach((t, i) => T.push({ label: "Deposit" + (n.inTxs.length > 1 ? " " + (i + 1) : ""), ts: t.ts, hash: t.hash, chainId: t.chainId, url: txUrl(t.chainId, t.hash) }));
  const outLabel = n.status === "refund" ? "Refund" : "Fill";
  n.outTxs.forEach((t, i) => T.push({ label: outLabel + (n.outTxs.length > 1 ? " " + (i + 1) : ""), ts: t.ts, hash: t.hash, chainId: t.chainId, url: txUrl(t.chainId, t.hash) }));
  n.refunds.filter(r => !n.outTxs.some(o => o.hash === r.hash)).forEach(r => T.push({ label: "Refund", hash: r.hash, chainId: r.chainId, url: txUrl(r.chainId, r.hash) }));
  if (n.updatedAt) T.push({ label: "Last update", ts: n.updatedAt });
  return T;
}

function money(n, totQ, totA) {
  if (!n.amountIn && !n.amountOut && totA == null) return null;
  const top = n.gasTopup && n.gasTopup.usd || 0;
  const realCost = totA != null ? Math.max(0, -totA - top) : null;
  return { amountIn: n.amountIn, amountOut: n.amountOut, gasTopup: n.gasTopup, quoted: n.fees.quoted, actual: n.fees.actual, totQ, totA, realCost, slippagePct: n.slippageBps != null ? n.slippageBps / 100 : null };
}

/* ---------- drafts ---------- */
function draftUser(c) {
  const n = c.n, lines = [];
  const link = (t) => t ? (txUrl(t.chainId, t.hash) || t.hash) : null;
  lines.push("Hi! Thanks for the details, I've checked your transfer (" + short(n.id) + ").");
  lines.push("");
  switch (n.status) {
    case "success":
      lines.push("Good news: it completed. " + (n.amountOut ? fmtAmt(n.amountOut) + " was" : "Your funds were") + " delivered on " + chainName(n.destChainId) + (c.fillSec != null ? (c.fillSec < 2 ? " within a second or two of your deposit" : " about " + fmtDur(c.fillSec) + " after your deposit") : "") + ".");
      if (c.userCost != null) lines.push("You sent about " + fmtUsd(n.amountIn.usd) + " and received about " + fmtUsd(n.amountOut.usd) + (n.gasTopup && n.gasTopup.usd ? " plus " + fmtUsd(n.gasTopup.usd) + " of gas" : "") + ", so the total cost (swap, network gas and fees together) was about " + fmtUsd(c.userCost) + "." + (c.reason ? " " + c.reason.user : ""));
      if (c.userCost != null) lines.push("The network fee your wallet showed when you sent the transaction is separate: it goes to the " + chainName(n.originChainId) + " network, not to us." + (n.originChainId === 1 ? " Ethereum's network fees are the highest of any chain, which is often the biggest cost of a transfer from Ethereum." : ""));
      if (n.gasTopup) lines.push("You also received " + fmtAmt(n.gasTopup) + " for gas on " + chainName(n.gasTopup.chainId || n.destChainId) + ". That's the gas top-up you chose, so it shows up in the cost breakdown, but it's yours.");
      if (n.outTxs[0]) lines.push("", "You can see it here: " + link(n.outTxs[0]));
      lines.push("", "If you don't see it in your wallet:", "1. Switch your wallet to the " + chainName(n.destChainId) + " network.", "2. Check you're looking at " + (n.recipient ? "the wallet ending in " + n.recipient.slice(-4) : "the receiving wallet") + ".", "3. If the token still doesn't show, add it manually as a custom token.");
      break;
    case "refund":
      lines.push("Your transfer couldn't be completed, so the funds were sent back to you on " + chainName(n.originChainId) + ", the network you sent from.");
      if (c.err) lines.push("", "What happened: " + c.err.user);
      lines.push("", "The refund is a little less than you sent because the network fee for sending it back is deducted.");
      if (n.outTxs[0] || n.refunds[0]) lines.push("", "Refund transaction: " + link(n.outTxs[0] || n.refunds[0]));
      if (c.err && c.err.cat === "transient") lines.push("", "This was a temporary issue, so it's fine to try again with a fresh quote.");
      break;
    case "failure":
      lines.push("The last step of your transfer didn't go through" + (c.err ? ". " + c.err.user : "."));
      lines.push("", c.escalate ? "I've passed this to our engineering team with all the details, and I'll update you here as soon as I hear back. Your deposit is recorded, so nothing is lost while we review it." : "This can still resolve on its own: the system may retry, or refund you automatically on " + chainName(n.originChainId) + ". I'll keep an eye on it and update you.");
      break;
    case "waiting":
      lines.push("I don't see a deposit for this transfer yet. Could you send me the transaction hash from your wallet's activity tab? It starts with 0x.");
      lines.push("", "Also let me know which network you sent from. If the transaction failed in your wallet or went out on a different network, that would explain it.");
      break;
    default:
      lines.push("Your deposit is confirmed and the transfer is being completed on " + chainName(n.destChainId) + ".");
      lines.push("", c.escalate ? "It's taking longer than normal, so I've escalated it to our engineering team with the full details. I'll update you here as soon as I have news. Your funds are tracked the whole time." : "These usually finish within a couple of minutes. I'll check again shortly and confirm.");
  }
  lines.push("", "One reminder: our team will never ask for your seed phrase or private key, or DM you first. Please only share transaction IDs and hashes.");
  return lines.join("\n");
}

function draftDev(c) {
  const n = c.n, L = [];
  L.push("Request " + n.id);
  L.push("status: " + n.status + (n.failReason ? " | failReason: " + n.failReason : "") + (n.refundFailReason ? " | refundFailReason: " + n.refundFailReason : ""));
  L.push("route: " + chainName(n.originChainId) + " (" + n.originChainId + ") → " + chainName(n.destChainId) + " (" + n.destChainId + ")");
  if (n.inTxs[0]) L.push("deposit: " + n.inTxs.map(t => t.hash).join(", "));
  if (n.outTxs[0]) L.push((n.status === "refund" ? "refund: " : "fill: ") + n.outTxs.map(t => t.hash).join(", "));
  if (c.fillSec != null) L.push("deposit → fill: " + fmtDur(c.fillSec));
  if (c.cost && c.cost.gross > 0) L.push("cost (" + c.cost.phase + ", USD): " + c.cost.parts.map(p => p.key + " " + p.usd.toFixed(4)).join(", ") + (c.cost.sponsored ? ", sponsored " + c.cost.sponsored.toFixed(4) : "") + (c.cost.gasTopup ? " (gas top-up of " + c.cost.gasTopup.toFixed(4) + " already taken out)" : "") + (c.reason ? "\n" + c.reason.agent : ""));
  L.push("");
  if (c.err) L.push("What it means: " + c.err.dev);
  if (c.rerr) L.push("Refund: " + c.rerr.dev);
  if (n.status === "success") L.push("This request completed normally. If your UI shows it as stuck, check that you poll /intents/status/v3 until a final status (success or refund) or use webhooks/websockets instead of polling.");
  if (n.status === "waiting") L.push("No deposit is indexed for this requestId. Make sure the user executes the quote's steps in order and that the deposit includes the request ID in calldata. If the deposit landed, you can notify the indexer with POST /transactions/index.");
  if (["pending", "depositing", "submitted"].includes(n.status)) L.push(c.escalate ? "Stuck beyond normal fill times; we've escalated internally." : "In progress. Final statuses are success and refund; keep polling at a modest interval or subscribe to webhooks.");
  if (n.status === "failure" && !c.escalate) L.push("failure isn't final: it can move to pending (retry) or refund. Keep polling unless refundFailReason is set.");
  if (n.source === "requests v2") L.push("", "Heads-up: you're on GET /requests/v2, which is rate-limited in stages and retires on 24 Nov 2026. v3 needs x-api-key; inTxs[].hash → txHash, expandedPriceImpact → data.fees, \"N/A\" → null. Migration guide: https://docs.relay.link/references/api/api_guides/migrating-to-requests-v3");
  return L.join("\n");
}

function draftEscalation(c, checks) {
  const n = c.n, L = [];
  L.push("ESCALATION: " + (n.failReason || n.refundFailReason || n.status) + " on " + chainName(n.originChainId) + " → " + chainName(n.destChainId));
  L.push("Request ID: " + n.id);
  L.push("Relay page: " + relayTxUrl(n.id));
  L.push("Status: " + n.status + " | failReason: " + (n.failReason || "none") + " | refundFailReason: " + (n.refundFailReason || "none"));
  L.push("Route: " + c.route);
  if (n.inTxs.length) L.push("Deposit: " + n.inTxs.map(t => t.hash + " (" + chainName(t.chainId) + ")").join("; "));
  if (n.outTxs.length) L.push("Fill/refund: " + n.outTxs.map(t => t.hash + " (" + chainName(t.chainId) + ")").join("; "));
  if (n.failedTxHash) L.push("failedTxHash: " + n.failedTxHash);
  L.push("Created: " + fmtUtc(n.createdAt) + " | Last update: " + fmtUtc(n.updatedAt) + (c.idleSec != null ? " (" + fmtDur(c.idleSec) + " ago)" : ""));
  if (n.user) L.push("User wallet: " + n.user + (n.recipient && n.recipient.toLowerCase() !== (n.user || "").toLowerCase() ? " | Recipient: " + n.recipient : ""));
  L.push("Why escalating: " + (c.why || "Needs engineering review."));
  L.push("Already checked: request status and reason codes; deposit present on " + chainName(n.originChainId) + (n.outTxs.length ? "; fill/refund hash present" : "; no fill or refund hash yet") + ".");
  L.push("User told: we're reviewing and will update them. No funds moved by support.");
  return L.join("\n");
}

module.exports = { costBreakdown, COST_PARTS, parseInput, diagnose, normalize, ERRORS, CHAINS, OWNER, OWNER_GROUPS, OWNER_LABEL, ownerOf, errInfo, chainName, txUrl, relayTxUrl, explorerName, fmtUsd, fmtAmt, fmtDur, fmtUtc, short, isHash, isAddr, toMs };
