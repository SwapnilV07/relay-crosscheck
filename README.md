# Relay Crosscheck

Support tooling for [Relay](https://relay.link) integrations. It catches problems before they become tickets, shows when an integrator is in trouble, and diagnoses individual transfers.

```
npx relay-crosscheck scan ./src                 # Will this integration break?
npx relay-crosscheck health --api-key $KEY      # Is this integrator in trouble, and who can fix it?
npx relay-crosscheck ticket 0x1791…a739         # What happened to this transfer? Draft the replies.
```

Node 18 or newer. No dependencies. Independent project, not an official Relay product.

**Run it without installing** (straight from GitHub): `npx github:SwapnilV07/relay-crosscheck scan ./src`
**Or clone it:** `git clone https://github.com/SwapnilV07/relay-crosscheck && cd relay-crosscheck && node bin/relay-crosscheck.js --help`

## Why it exists

Relay shipped 11 breaking changes, 22 behavior changes and 4 deprecations between May and October 2026 ([changelog](https://docs.relay.link/changelog)). `/requests/v2` retires on 24 November 2026, and its public rate limit already refuses a third lookup in a row. Integrators who miss a change find out from their users. Their users then write to Relay support.

At the same time, integrators measure Relay's reliability from their own side. In October 2026 Pump.fun published an 11.2% buy error rate for Relay and moved to its own bridge. Its own export shows those errors split by chain and by type in ways a support team could have acted on during the test.

Relay Crosscheck gives support three tools for this:

| Command | Who runs it | What it answers |
| --- | --- | --- |
| `scan` | The integrator's developer, or their CI | Which of Relay's changes break this code, by when, and how to fix it |
| `health` | Relay support or integrations | An integrator's error rate by chain and day, who can fix each error, and a draft email to them |
| `ticket` | A support agent | What happened to one transfer, with replies for the customer and the developer, and an escalation note |

## `scan`

```
npx relay-crosscheck scan ./path/to/app
```

It checks code against 25 rules taken from Relay's changelog and docs. Each finding links to its source page. Examples:

- calls to `/requests/v2` (deadline 24 Nov 2026; it becomes "breaking" automatically after that date)
- quote calls without an `x-api-key`
- Relay router or approval addresses written into the code, including the ones replaced on 26 Oct 2026
- removed endpoints and fields (`/execute/swap`, `fallbackType`, `includeProtocolSignature`)
- `slippageTolerance` sent as a decimal or a percentage instead of basis points
- status handling that treats `failure` as final, never handles `refund`, or polls faster than once a second
- webhook handlers that don't verify `X-Signature-SHA256`

It skips tests, comments, generated files and `node_modules`. It exits with 1 when it finds breaking problems, so it can block a deploy (`--fail-on` changes the threshold). `--sarif` writes a file that GitHub shows inline on pull requests.

### In GitHub Actions

```yaml
- uses: SwapnilV07/relay-crosscheck@v0
  with: { path: src, fail-on: breaking }
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: relay-crosscheck.sarif }
```

### Tested on real code

- **RelayKit** (Relay's own SDK and UI kit, 28 Oct 2026): it found that the deposit-address modal and the Onramp widget stop polling on `failure` and show an error. Relay's docs, updated 24 Oct, say `failure` is not final. See [docs/relaykit-failure-polling.md](docs/relaykit-failure-polling.md).
- **OpenChainBench** (an independent benchmark that reads Relay's API): it found three `/requests/v2` calls that stop working on 24 Nov.

## `health`

```
# Live, with a Relay API key (uses /requests/v3)
npx relay-crosscheck health --api-key $RELAY_API_KEY --app app_id_… --since 7d --name "Acme Wallet" --html report.html --email email.txt

# From a saved export
npx relay-crosscheck health --counts errors.csv --name "Acme Wallet" --html report.html
npx relay-crosscheck health --requests saved-requests.json --html report.html
```

It produces:

- the error rate overall, by chain and by day
- each error assigned to who can most likely fix it: the integrator, Relay, the end user, market conditions, or the token or chain. This mapping covers all 73 fail reasons in Relay's API schema and is a support heuristic, not an official classification.
- **hotspots**: a chain where one kind of error runs at least double the integrator's other chains
- **days that stand out**: a day at least 1.5× and 2 points above the same chain's other days
- requests open for more than 30 minutes, with their IDs
- a draft email to the integrator: what changed, what Relay is doing, what they can fix, and any questions
- a self-contained HTML report you can open or forward

### Example: Pump.fun's published data

```
npx relay-crosscheck health --counts examples/pumpfun-relay-ab-daily.csv --direction buy --name Pump.fun --html report.html
```

This reproduces Pump.fun's 11.2% buy error rate exactly, then shows what was behind it:

- 53% of errors are labelled `relay_failure`, and they concentrate on BNB Chain (10.4% of buys, every day of the test) against 2.4% on Pump.fun's other chains
- 36% are labelled `sponsorship`, which most likely means the integrator's fee-sponsorship balance. The export doesn't define the label, so the report asks
- a sponsorship spike on Robinhood Chain on 29 Sep (7.8% against 3.5% on other days)

See [examples/sample-report](examples/sample-report). The data is Pump.fun's own A/B export as reduced to counts by [OpenChainBench](https://github.com/ChainBench/OpenChainBench/pull/3187).

## `ticket`

```
npx relay-crosscheck ticket <request id | transaction hash | wallet>
npx relay-crosscheck ticket 0x… --reply customer      # just the customer reply
npx relay-crosscheck ticket 0x… --api-key $KEY        # search /requests/v3
```

Without a key it uses the status API first, which isn't tightly rate-limited, and calls `/requests/v2` only for details or for transaction hashes. When v2 is rate-limited it stops and says so instead of retrying.

The output covers the status in plain English, findings (fill time, total cost, gas top-up, a recipient that differs from the sender, stuck requests), a timeline with explorer links, next checks, and three drafts: a customer reply, a developer reply, and an escalation note when one is needed. Every customer reply ends with a reminder that support never asks for seed phrases.

## Testing

```
npm test
```

There are 24 tests. They cover the reason table against Relay's API schema, every scan rule on a broken and a correct integration, the health maths against Pump.fun's published figures, HTML escaping, and every ticket lookup path. The ticket tests use responses recorded from the live API on 28 Oct 2026 (`test/fixtures/live-2026-10-28`).

## Limits

- `scan` matches patterns. It catches the common ways an integration goes wrong, not every possible one.
- The owner mapping is a support heuristic, so check unusual cases.
- Without an API key, lookups depend on `/requests/v2` until it retires on 24 Nov 2026. After that, wallet and hash lookups need a key.

## Licence

MIT. Built by Swapnil Vhangunde.
