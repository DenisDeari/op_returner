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

This is not theoretical. On 2026-05-26 a customer paid 2311 sats with
`amountToSend: 100`. That is below Bitcoin's 546-sat dust limit, so the signed
transaction was non-standard and the network rejected it — after the money was taken.
Nothing retried it, nothing refunded it, and nobody noticed for 66 days. It was finally
delivered on 2026-08-01 in tx `900e71e3…`.

## Invariants — do not break these

| Invariant | Enforced in |
|---|---|
| A recipient output is 0 or ≥ 546 sats (dust limit) | `routes/api.js`, clamped again in `op_return_creator.js` |
| The effective fee rate is never below `MIN_EFFECTIVE_FEE_RATE` (2 sat/vB) | `config.js`, applied in `op_return_creator.js` and `refund.js` |
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
  op_return_creator.js  builds, signs and broadcasts the OP_RETURN transaction
  refund.js             returns funds to the payer when a request terminally fails
  reconcile.js          periodic safety net: unstick, retry, refund, report
  chain_providers.js    BlockCypher → blockstream.info → mempool.space, with fallback
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

## Error classification

`chain_providers.js` sorts broadcast errors into four buckets. Getting this wrong is
expensive, so check it when touching provider code:

- **already broadcast** (`txn-already-known`) → this is *success*, not failure
- **fee too low** → retryable, and worth trying the other providers
- **inputs already spent** → an earlier attempt probably confirmed; never auto-refund
- **permanent** (dust, malformed) → stop, refund

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
  gap limit. Abandoned orders leave unused indices, and this wallet already has gaps
  wider than 20 (the highest index is 51 with only 19 orders), so a plain gap scan walks
  straight past later addresses that may hold a customer's money.
- **Scanning must never cost the money paths their API budget.** BlockCypher bills each
  address in a multi-address request separately, so one scan returned twenty `429`s and
  spent the allowance the webhooks depend on. Balance lookups therefore go to the Esplora
  hosts only. Do not "optimise" this back to BlockCypher batching.

mempool.space is **not reachable from this machine** — the connection times out, at every
resolver, so it is not a DNS problem. It is still listed as a provider (it may come back,
and the fallback handles it), but it is ordered last for balance lookups, and a provider
that times out or rate-limits is now demoted for 60 seconds so a scan does not pay the
same rejection once per address. Admin-panel explorer links point at blockstream.info for
the same reason.

A balance that could not be read is never rendered as zero. The last known figure is kept
in memory and in `system_settings.wallet_balance_cache`, shown with its age, and the
response carries `incomplete` / `staleCount` so the panel can say so plainly.

## Testing

There is no test runner in the repo. Verification lives outside it: a unit harness
(58 assertions, stubs the chain layer so nothing is broadcast) and an end-to-end suite
(20 API tests against a real server on a throwaway database). Rehearse any schema change
against a *copy* of the production database before deploying.

For manual checks, never point a test server at production data. The live database lives
in the `op-returner_op_returner_data` Docker volume.

## Deploying

`backend/` and `frontend/` are bind-mounted into the container, so a code change needs a
`docker restart op_returner` — `docker compose up -d` alone will not reload JS. Only
compose-file or env changes need `up -d`.

Schema migrations are additive `ALTER TABLE ADD COLUMN` statements in `database.js`,
applied on boot. The HTTP listener and the scheduled jobs both start only after
`initializeDatabase` signals ready — do not move `app.listen` back out of that callback,
or early requests will hit a database with no `wallet_state` row.

## Secrets

`.env` holds the wallet mnemonic, admin password, BlockCypher token, Telegram bot token
and Cloudflare tunnel token. It is gitignored (as is `.env.*`, so backups cannot be
committed either). `docker-compose.yml` passes them by reference. Never print these
values, and never copy `.env` to a path that is not ignored.
