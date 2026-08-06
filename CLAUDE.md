# op_returner / SatWire — notes for future agents

Live Bitcoin service at <https://satwire.io>. A customer pays to an address we derive,
and we publish their message on-chain in an `OP_RETURN` output. **This code moves real
customer money.** Read this before changing anything under `backend/src/`.

## The rule everything else follows from

**Never take money for a transaction we cannot broadcast.**

Every economic parameter is validated in `routes/api.js` (`validateRequestParams`)
*before* a payment address is quoted. If you add a new parameter that affects the
transaction, validate it there too — not in the builder, which runs after the customer
has already paid.

This is not theoretical. It has now cost customers money twice:

- **2026-05-26** — a customer paid 2311 sats with `amountToSend: 100`, below the 546-sat
  dust limit. The signed transaction was non-standard and the network rejected it, after
  the money was taken. Nothing retried it, nothing refunded it, and nobody noticed for
  66 days. Delivered eventually on 2026-08-01 in tx `900e71e3…`.
- **2026-08-06** — four orders in ninety minutes, one customer, all paying a **P2WSH**
  recipient. Every fee estimate in the codebase added a flat 31 vBytes for the recipient
  output, the size of a *P2WPKH* output; a P2WSH output is 43. Two orders were priced
  below the minimum relay fee and caught before broadcast; two cleared that and were
  rejected by BlockCypher as dust, because 548 sats clears our flat 546 limit but not the
  573 BlockCypher wants for that output type. All four were auto-refunded, correctly and
  within a second — but the customer paid 1526 sats in refund fees for our arithmetic and
  got nothing published. See **Sizing and dust** below.

The pattern in both: an economic assumption that was true for the *common* case, applied
to a case that did not match. Size and price everything from the actual scriptPubKey.

## Invariants — do not break these

| Invariant | Enforced in |
|---|---|
| A recipient output is 0 or ≥ the dust limit **for its own script type** | `routes/api.js`, clamped again in `op_return_creator.js` and `treasury.js` |
| Output sizes come from the real scriptPubKey, never from an assumed address type | `tx_sizing.js`, used by `queue.js`, `op_return_creator.js`, `refund.js`, `treasury.js` |
| The effective fee rate is never below `MIN_EFFECTIVE_FEE_RATE` (2 sat/vB) | `config.js`, applied in `op_return_creator.js` and `refund.js` |
| The built transaction's fee clears the relay minimum for its *actual* signed size | `op_return_creator.js`, checked after `extractTransaction` |
| Outputs never exceed inputs — checked *before* signing | `op_return_creator.js` |
| A request that has any sign of payment is never deleted | `cleanup.js`, `routes/api.js` DELETE |
| A refund never runs twice — conditional `UPDATE` acts as the lock | `refund.js` |
| Never auto-refund when the payment UTXO is already spent | `NO_REFUND_FAILURES`, `reconcile.js` |
| The refund address comes from the chain, never from the webhook body | `routes/webhook.js` |
| Nothing user-supplied reaches `innerHTML` unescaped | `frontend/admin/admin.js`, `frontend/js/app.js` |
| The wallet view never spends BlockCypher's quota | `chain_providers.js` `getAddressSummaries` |
| A balance that could not be read is never shown as 0 | `wallet_scan.js`, `incomplete` / `stale` flags |

A fee at exactly 1 sat/vByte sits on the minimum relay fee and providers reject it as
`non standard: low fee rate`. That is why the floor is 2, not 1. The extra always comes
out of the service fee, never out of what the customer is charged.

## Layout

```
backend/src/
  routes/api.js         intake validation, status polling, customer feedback endpoint
  routes/webhook.js     BlockCypher payment callbacks — UNAUTHENTICATED, treat body as hostile
  routes/admin.js       Bearer-token admin API (fulfil, refund, alerts)
  routes/internal.js    API-key-only, treasury-funded publishing
  queue.js              derives the address and computes the quote
  tx_sizing.js          output sizes and dust limits, derived from the scriptPubKey
  op_return_creator.js  builds, signs and broadcasts the OP_RETURN transaction
  refund.js             returns funds to the payer when a request terminally fails
  reconcile.js          periodic safety net: unstick, retry, refund, report
  chain_providers.js    BlockCypher → mempool.space → blockstream.info, with fallback
  alerts.js             current problems, computed from the DB (not from logs)
  notifier.js           Telegram messages on every order event
  cleanup.js            deletes only old, provably unfunded requests
  wallet_scan.js        read-only balance view over every branch of the seed
  qr.js                 BIP21 payment URIs rendered as SVG QR codes
  routes/wallet.js      admin-only, strictly read-only wallet API
  routes/auth.js        the admin bearer check, shared by admin.js and wallet.js
```

`reconcile.js` runs on startup and every 30 minutes. It is the reason a dropped request
can no longer go unnoticed — but it also means **a deploy can move real money**, because
it will finish any order left stranded.

## Sizing and dust

`tx_sizing.js` is the single source of truth. Nothing else may hardcode an output size or
a dust threshold.

An output is `8 + 1 + script.length` vBytes. The sizes that matter:

| Type | Output | Dust limit we use |
|---|---|---|
| P2PKH (`1…`) | 34 | 546 |
| P2SH (`3…`) | 32 | 546 |
| P2WPKH (`bc1q…`, 42 chars) | 31 | 546 |
| P2WSH (`bc1q…`, 62 chars) | 43 | **573** |
| P2TR (`bc1p…`) | 43 | **573**, but see below |

The dust limit is Bitcoin Core's `GetDustThreshold`: 3 sat/vB against the cost of making
the output plus the cost of spending it. **Core discounts the witness part of that spend;
BlockCypher does not.** Core would take a 330-sat P2WSH output; BlockCypher wants 573 and
is first in the broadcast order. We quote against the stricter, undiscounted rule — a
threshold that clears every provider is the only one that keeps the promise above.

The result is floored at `DUST_LIMIT_SATS` (546), so this is only ever a tightening: the
undiscounted formula puts P2WPKH at 537 and P2SH at 540, and relaxing a limit that is not
causing trouble buys nothing.

The change output is always P2WPKH, so the flat 546 is the right limit for it. The
*recipient* output is whatever the customer gave us.

**Taproot recipients do not work today, and the P2TR row above is theory.** bitcoinjs
routes a bech32m v1 address through `payments.p2tr()`, which needs an ECC backend
registered via `initEccLib`. The only call is in `wallet_scan.js`, deliberately lazy and
scoped to its own address derivation, so the payment path has none: `toOutputScript`
throws and intake reports a perfectly valid `bc1p…` address as *not a valid Bitcoin
address for this network*. It fails closed — no money is taken — but a customer paying
to taproot is simply turned away, and a taproot payer cannot be auto-refunded either.
Fixing it is a one-line global `initEccLib`; the unit harness asserts the current
behaviour so the day it changes is a deliberate one.

`frontend/js/app.js` mirrors this arithmetic to preview the cost and to name the minimum
next to the amount field. It recognises types by address prefix rather than decoding —
it only drives a preview, and the server remains the authority — but if you change
`tx_sizing.js`, change it there too or the quote will not match what was displayed.

## Error classification

`chain_providers.js` sorts broadcast errors into buckets. Getting this wrong is
expensive, so check it when touching provider code:

- **already broadcast** (`txn-already-known`) → this is *success*, not failure
- **fee too low** → retryable, and worth trying the other providers
- **inputs already spent** → an earlier attempt probably confirmed; never auto-refund
- **dust** → permanent, but only after every provider has been asked (see below)
- **permanent** (malformed, bad-txns-*) → stop at the first host, refund

`tryProviders` stops at the first *permanent* rejection and never consults the remaining
hosts, so whichever host answers first gets to declare a transaction invalid — and a
permanent rejection is what triggers an automatic refund.

**Dust is the one exception, because providers genuinely disagree about it.** On
2026-08-06 BlockCypher called two transactions dust and the fallback stopped dead;
neither Esplora host was ever asked, and both would almost certainly have accepted them.
A dust rejection now falls through to the remaining providers and is only reported as
permanent once none of them has contradicted it. It stays *permanent* rather than
retryable, because no amount of retrying changes an output value — the request should
refund, not spin.

Do not extend that exception to anything else without the same evidence of disagreement.

## The wallet view

`wallet_scan.js` derives addresses and asks a block explorer what it sees. It never
signs and never spends — keep it that way. If a spend endpoint is ever added to
`routes/wallet.js`, that file becomes a money path and needs the locking and idempotency
care that `refund.js` has.

The seed uses three branches under `m/84'/0'/0'`:

| Branch | What is there |
|---|---|
| `/0/i` | one payment address per order; a balance here is undelivered customer money |
| `/1/i` | change from each published message — the service's actual earnings |
| `/2/0` | the treasury, which pays for self-funded and free messages |

Electrum and Sparrow scan only `/0` and `/1`, so the treasury is invisible to them. That
is why the panel can scan an arbitrary path, and why the earnings on `/1` were unseen
before this existed.

Three things here are load-bearing:

- **Topping up the treasury must go to `/2/0` exactly.** `treasury.js` spends from that
  one address and no other, so the branch carries `fixedReceiveIndex: 0` and the panel
  offers that address rather than a fresh one. A "next unused" address would be money
  the free-proof service cannot reach.
- **The receive branch is scanned past the highest index ever issued**, not just to the
  gap limit. Abandoned orders leave unused indices — index 61 was issued and deleted
  unfunded on 2026-08-06, and this wallet already has gaps wider than 20 — so a plain gap
  scan walks straight past later addresses that may hold a customer's money.
- **Scanning must never cost the money paths their API budget.** BlockCypher bills each
  address in a multi-address request separately, so one scan returned twenty `429`s and
  spent the allowance the webhooks depend on. Balance lookups therefore go to the Esplora
  hosts only. Do not "optimise" this back to BlockCypher batching.

Connections from this machine to mempool.space time out most of the time — not always,
it does get through intermittently. Every resolver returns the same addresses, so it is
not DNS. It is still a provider, but it is ordered last for balance lookups, and any host
that times out or rate-limits is demoted for 60 seconds so a scan does not pay the same
failure once per address. Admin-panel explorer links point at blockstream.info for the
same reason.

**That demotion is opt-in, and broadcasts must never use it** — see the note in
`tryProviders` about who gets to declare a transaction invalid. A wallet scan tripping a
rate limit must not be able to reshuffle that.

A scan is bounded by `WALLET_SCAN_BUDGET_MS`. Past it the scan stops, falls back to the
last known figures, and reports `incomplete`. This matters: it runs inside an admin HTTP
request, and with one Esplora host rate-limiting while the other times out, an unbounded
scan spent over a minute failing.

A balance that could not be read is never rendered as zero. The last known figure is kept
in memory and in `system_settings.wallet_balance_cache`, shown with its age, and the
response carries `incomplete` / `staleCount` so the panel can say so plainly.

## Testing

There is no test runner in the repo. Verification lives outside it, in
`/home/admin/op_returner_tests/`:

- `unit_harness.js` — 85 assertions. Stubs the chain layer, so nothing is broadcast and
  no network call is made. Run it with `node unit_harness.js`; exit code 0 means clean.
- `provider_fallback.js` — 12 assertions over the broadcast fallback, with `axios.post`
  stubbed before `chain_providers.js` is required.

Both point at `/home/admin/webseiten/op_returner/backend/src` by absolute path, so they
test the deployed tree directly. They previously lived in a session scratchpad under
`/tmp`, one reboot away from being lost.

An end-to-end suite also exists (20 API tests against a real server on a throwaway
database). Rehearse any schema change against a *copy* of the production database before
deploying.

**Prove a guard actually fires before trusting it.** Copy `backend/src` to a temp dir,
symlink `node_modules` next to it, reintroduce the bug there, point a copy of the harness
at it by editing its `SRC` constant, and check the assertions fail. Reintroducing the
flat 31-vByte recipient output this way reproduces the 2026-08-06 production error
verbatim — `computed fee 458 sats is below the 476 sat minimum for a 238 vByte
transaction`. Never do this against `backend/src` itself.

`refund.js` exports `estimateRefundVBytes`, which the harness asserts against. It takes a
second argument (the refund output's size) and uses a 10.5-vByte overhead rather than 10,
so a single-input P2WPKH sweep is 110 vBytes, not 109. The old numbers priced the four
refunds of 2026-08-06 at 1.96 sat/vB against a floor that is meant to be 2.

Two useful patterns when changing anything that builds a transaction:

- Build and sign the real PSBT with a throwaway key and compare `virtualSize()` against
  the estimate. The estimate must never come out below the real size.
- Stub `axios.post` before requiring `chain_providers.js` to exercise the fallback order
  without touching the network. The broadcast order is blockcypher, mempool.space,
  blockstream.info.

For manual checks, never point a test server at production data. The live database lives
in the `op-returner_op_returner_data` Docker volume.

## Deploying

`backend/` and `frontend/` are bind-mounted into the container, so a code change needs a
`docker restart op_returner` — `docker compose up -d` alone will not reload JS. Only
compose-file or env changes need `up -d`. **Editing a file under `backend/src/` changes
nothing until that restart**, so a "fixed" money path is still broken until you do it.

Schema migrations are additive `ALTER TABLE ADD COLUMN` statements in `database.js`,
applied on boot. The HTTP listener and the scheduled jobs both start only after
`initializeDatabase` signals ready — do not move `app.listen` back out of that callback,
or early requests will hit a database with no `wallet_state` row.

## Secrets

`.env` holds the wallet mnemonic, admin password, BlockCypher token, Telegram bot token
and Cloudflare tunnel token. It is gitignored (as is `.env.*`, so backups cannot be
committed either). `docker-compose.yml` passes them by reference. Never print these
values, and never copy `.env` to a path that is not ignored.
