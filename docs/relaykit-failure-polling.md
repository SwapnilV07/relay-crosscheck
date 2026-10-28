# Draft issue for relayprotocol/relay-kit

**Title:** Deposit-address modal and Onramp widget stop polling on `failure`, which the docs say isn't final

**Where**
- `packages/ui/src/components/common/TransactionModal/DepositAddressModalRenderer.tsx`, around line 241
- `packages/ui/src/components/widgets/OnrampWidget/modals/OnrampModal.tsx`, around line 242

Both use:

```ts
const terminalStates = ['success', 'failure', 'refund']
const status = query.state.data?.status
return status && terminalStates.includes(status) ? 0 : 1000
```

and then show the error step as soon as the status is `failure`.

**Why it matters**
The Get Status docs (updated 24 Oct 2026 in relay-docs #518) say only `success` and `refund` are final. A `failure` can be retried back to `pending` or move to `refund`, and polling should only stop on `failure` when `refundFailReason` is set.

With the current code, a deposit-address or onramp user sees "Oops! Something went wrong" and the widget stops tracking, even if the request later fills or is refunded. That is the same pattern behind the integrator issue in Ellipsis-Labs/phoenix-v1#52, where a user couldn't see what happened to a failed deposit.

**Suggested change**
- Treat only `success` and `refund` as terminal. Keep polling through `failure` unless the response carries a `refundFailReason`.
- Optionally show a "retrying" state on `failure` instead of the error step, and move to the error step on `refund` or on `failure` with `refundFailReason`.

Found with relay-crosscheck (`relay-crosscheck scan packages`), rule `failure-treated-as-final`.
