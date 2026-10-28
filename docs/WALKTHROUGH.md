# Relay Crosscheck: walkthrough for Swapnil

Read this before you share the project or talk about it. It explains what each part does, why, and what to say.

## The one-line pitch

"Relay changed its API 37 times in six months and lost Pump.fun publicly, so I built a support tool that catches integration problems before they become tickets, spots an integrator in trouble from their data, and diagnoses a single transfer in seconds."

## How I built it (be honest about this)

I designed it and built it with Claude, which is the kind of AI use the job post asks for. I chose what it should do from my own research: the changelog, Pump.fun's data, GitHub issues, and my own transfers. I checked every output and can explain every rule. If asked, say exactly that. Don't claim you hand-wrote the code.

## The three commands

### 1. `scan`: "Will this integration break?"

- **Who runs it:** an integrator's developer, on their own code. Relay support sends them the command, for example in a "v2 retires on 24 November" email.
- **What it checks:** 25 rules, each taken from Relay's changelog or docs, for example `/requests/v2`, missing API keys, old contract addresses, slippage in the wrong format, treating `failure` as final.
- **Why it matters:** each rule is a future ticket. Fixing it in the integrator's code stops the ticket from ever happening.
- **Real result to mention:** I ran it on Relay's own RelayKit code. It found that the deposit-address and onramp widgets stop tracking a transfer on `failure`, which Relay's docs changed on 24 October to say isn't final. I wrote it up as a draft GitHub issue (`docs/relaykit-failure-polling.md`). Offer it to them; don't post it publicly before talking to them.

### 2. `health`: "Is this integrator in trouble, and who can fix it?"

- **Who runs it:** Relay support, with Relay's API access. The integrator only receives the email.
- **What it does:** it takes request data and shows the error rate by chain and day, splits every error by who can fix it (integrator, Relay, user, market, token or chain), flags chains and days that stand out, and drafts the email.
- **The demo:** Pump.fun's own published data. It reproduces their 11.2% exactly, then shows:
  - BNB Chain had Relay-side errors on 10.4% of buys on every day of the test, against 2.4% on other chains. That's a standing problem a daily check would have caught on day one.
  - 36% of errors were labelled "sponsorship," most likely Pump.fun's own fee-sponsorship balance running short. The tool asks rather than assumes.
- **How to say it:** "This isn't about Pump.fun being wrong. It's about support seeing this during the test, not three weeks later on X."

### 3. `ticket`: "What happened to this transfer?"

- **Who runs it:** a support agent, with whatever the customer sent: a request ID, a transaction hash, or a wallet.
- **What it gives:** a plain-English status, findings, a timeline with explorer links, next checks, a customer reply, a developer reply, and an escalation note when needed.
- **Real detail:** I tested it live against Relay's API on 28 Oct. Public `/requests/v2` lookups were already rate-limited after two or three calls, so the tool uses the status API first and stops cleanly instead of retrying.

## Numbers you should know

| Fact | Figure |
| --- | --- |
| Changelog changes integrators must act on, May to Oct 2026 | 11 breaking, 22 behavior, 4 deprecations |
| `/requests/v2` retirement | 24 Nov 2026 |
| Router switch (approvals reset) | 26 Oct 2026 |
| Fail reasons in Relay's API schema | 73, all mapped |
| Pump.fun buy error rate (their data) | 11.2% (11,496 of 102,513) |
| BNB Chain Relay-side errors vs other chains | 10.4% vs 2.4% |
| Tests | 24, all passing |

## Likely interview questions

- **Why not a dashboard?** Relay already has one. This runs today as a support tool. If it proves useful, its alerts (low sponsorship balance, chain spikes) could become part of the existing Dashboard.
- **What would you do on day one with access?** Run `health` on the top integrators, find who is still on v2 before 24 Nov, and send `scan` to them.
- **What are its limits?** Pattern matching can miss unusual code, the owner mapping is a heuristic, and wallet or hash lookups need a key after v2 retires.
- **What did you learn building it?** Only `success` and `refund` are final statuses. Refunds land on the origin chain, sometimes in a different token. And many errors that look like Relay's fault are configuration on the integrator's side.
