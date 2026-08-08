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

**2026-08-07 — a latent one, found by audit and fixed before it fired.** Archiving does not
overwrite `status`, and `reconcile.js` was the only read path in the service with no
`archivedAt` guard anywhere in it. A request the customer *cancelled* that was later paid
and force-fulfilled once would land at `op_return_failed` with a payment recorded — an
ordinary retry candidate. From there the scheduled pass owned it: it would republish a
message somebody had explicitly withdrawn, up to `MAX_FULFILL_ATTEMPTS`, with no human in
the loop, and `runReconciliation` runs on startup so the next deploy would have triggered
it. No customer hit this. The guard now sits on both publishing passes and deliberately
*not* on the refund pass — refusing to publish must not turn into keeping the money.

## Invariants — do not break these

| Invariant | Enforced in |
|---|---|
| A recipient output is 0 or ≥ the dust limit **for its own script type** | `routes/api.js`, clamped again in `op_return_creator.js` and `treasury.js` |
| Output sizes come from the real scriptPubKey, never from an assumed address type | `tx_sizing.js`, used by `queue.js`, `op_return_creator.js`, `refund.js`, `treasury.js` |
| The effective fee rate is never below `MIN_EFFECTIVE_FEE_RATE` (2 sat/vB) | `config.js`, applied in `op_return_creator.js` and `refund.js` |
| The built transaction's fee clears the relay minimum for its *actual* signed size | `op_return_creator.js`, checked after `extractTransaction` |
| Outputs never exceed inputs — checked *before* signing | `op_return_creator.js` |
| A request that has any sign of payment is never deleted | `cleanup.js`, `routes/api.js` DELETE |
| Automation never publishes a message the customer withdrew | `reconcile.js`, `archivedAt IS NULL` on both publishing passes |
| An archived request is never on the public wall | `wall.js` `WALL_SELECT_SQL` |
| A public response is a whitelist, never a row spread | `wall.js`, `PUBLIC_REQUEST_FIELDS` in `routes/api.js` |
| A confirmation that could not be read is never recorded as "unconfirmed" | `confirm_watch.js` |
| `opReturnConfirmedAt` is a UI signal — no money path may read it | asserted in `confirmations.js` |
| A refund never runs twice — conditional `UPDATE` acts as the lock | `refund.js` |
| Never auto-refund when the payment UTXO is already spent | `NO_REFUND_FAILURES`, `reconcile.js` |
| The refund address comes from the chain, never from the webhook body | `routes/webhook.js` |
| Nothing user-supplied reaches `innerHTML` unescaped | `frontend/admin/admin.js`, `frontend/js/app.js` |
| Wall messages are rendered with `textContent`, never through the escaper | `frontend/js/app.js` `renderWall` |
| The wallet view never spends BlockCypher's quota | `chain_providers.js` `getAddressSummaries` |
| A balance that could not be read is never shown as 0 | `wallet_scan.js`, `incomplete` / `stale` flags |
| Nothing in a webhook body is acted on until the chain confirms it | `routes/webhook.js` `verifyPaymentOnChain` |
| A request row is archived, never deleted | `cleanup.js`, `request_service.js` |
| An archived row is never a payment target, never fulfilled, never auto-refunded | `archivedAt IS NULL` in `routes/webhook.js`, `routes/api.js`, `cleanup.js` |
| An address that holds money is never archived — it is reported to a human | `cleanup.js` `recordUnexpectedPayment` |
| Every DDL statement lives in one place, shared with the tests | `schema.js` |
| A row is redacted, never removed — index, address and path always survive | `cleanup.js` `redactOldArchivedRequests` |
| A webhook teardown that could not be confirmed is never recorded as done | `cleanup.js`, `webhook_manager.js` `deleteWebhookIds` |
| A hook is judged by address as well as id, so a registration in flight is never pruned | `webhook_reconcile.js` `judgeHook` |
| An archived row holding money is never hidden from the operator | `routes/admin.js` |

A fee at exactly 1 sat/vByte sits on the minimum relay fee and providers reject it as
`non standard: low fee rate`. That is why the floor is 2, not 1. The extra always comes
out of the service fee, never out of what the customer is charged.

## Layout

```
backend/src/
  routes/api.js         intake validation, status polling, feedback, the wall, payment QR
  routes/webhook.js     BlockCypher payment callbacks — UNAUTHENTICATED, every value re-read from the chain
  routes/admin.js       Bearer-token admin API (fulfil, refund, alerts)
  routes/internal.js    API-key-only, treasury-funded publishing
  schema.js             every CREATE TABLE and column migration, side-effect free
  queue.js              derives the address and computes the quote
  tx_sizing.js          output sizes and dust limits, derived from the scriptPubKey
  op_return_creator.js  builds, signs and broadcasts the OP_RETURN transaction
  refund.js             returns funds to the payer when a request terminally fails
  reconcile.js          periodic safety net: unstick, retry, refund, report
  chain_providers.js    BlockCypher → mempool.space → blockstream.info, with fallback
  alerts.js             current problems, computed from the DB (not from logs)
  notifier.js           Telegram messages on every order event
  cleanup.js            retires webhooks at 62h, archives unfunded requests at 7 days
  webhook_reconcile.js  what BlockCypher actually holds, vs what the database believes
  request_events.js     durable per-request history — append-only, fire-and-forget
  wallet_scan.js        read-only balance view over every branch of the seed
  wall.js               the public message wall query, its cache, and why each term exists
  confirm_watch.js      notices when a published OP_RETURN actually reaches a block
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
| P2TR (`bc1p…`) | 43 | **573** |

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

**Taproot works, and it only works because `config.js` registers an ECC backend.**
bitcoinjs routes a bech32m v1 address through `payments.p2tr()`, which refuses to decode
one until `initEccLib` has been called. `wallet_scan.js` had the only call, lazy and
scoped to its own derivation, so until 2026-08-07 the payment path had none:
`toOutputScript` threw and intake reported a valid `bc1p…` address as *not a valid Bitcoin
address for this network*. It failed closed, so no money was ever at risk, but a Taproot
customer was turned away and a Taproot payer could not be auto-refunded.

The registration lives in `config.js` because every module on a money path requires
config, so there is no import order in which a Taproot address reaches `toOutputScript`
first. **Do not move it into a module that only some paths import.**

`frontend/js/app.js` mirrors this arithmetic to preview the cost and to name the minimum
next to the amount field. It recognises types by address prefix rather than decoding —
it only drives a preview, and the server remains the authority — but if you change
`tx_sizing.js`, change it there too or the quote will not match what was displayed.

Two details in that mirror are load-bearing and survived the 2026-08-08 rebuild verbatim:
the `bc1p` test must come **before** the `bc1q` one (a P2TR address is also 62 characters,
so a single "bc1" branch under-quotes both P2WSH and P2TR by 12 vBytes), and the amount
hint must keep naming the real minimum out loud. Parity was checked against
`tx_sizing.js` across all six address types after the rebuild; re-run that check if you
touch either side.

## The public wall

`wall.js` serves the messages customers chose to show on satwire.io. It is the only place
in the service where one customer's words are handed to strangers, so read the comment
block at the top of that file before changing the query — every term in the `WHERE` clause
is load-bearing and one of them is not obvious.

The non-obvious one: **`archivedAt IS NULL`**. Archiving deliberately does not overwrite
`status`, so a request the customer *cancelled* still reads `op_return_broadcasted` if it
was later paid and force-fulfilled. Without that term, a message somebody explicitly
withdrew appears on the homepage.

**`isPublic` already existed in the production database** as `INTEGER DEFAULT 1`, left from
the pre-2.0 schema — the code went in `a116ced`, the column could not follow, because
`ADD COLUMN` cannot be undone. Our migration therefore no-ops there with "duplicate column
name" and **the live default is still 1**, while a fresh database gets 0. All 25 existing
rows read `isPublic = 1`. Deploying against that naively would have published nineteen
customers' messages that nobody ever asked. Two things stop it, and both must stay:

- `routes/api.js` writes `isPublic` explicitly on **every** intake, 0 or 1 — never relying
  on the column default, because `queue.js`'s INSERT does not name the column and a row is
  therefore born `1`.
- `wall.js` additionally requires **`publicAt IS NOT NULL`**. That column is genuinely new,
  so it cannot have inherited anything: consent is the stamp, not the flag.

The 25 legacy rows were normalised to `isPublic = 0` on deploy. Do not "fix" the default in
`schema.js` — SQLite cannot alter one without rebuilding the table, and that is not worth
doing to a money database.

Three columns carry it, all defaulting to 0 on a *fresh* database:

| Column | Who sets it |
|---|---|
| `isPublic` | the customer, once, at intake — never changed afterwards |
| `hiddenByAdmin` | the operator, via `POST /api/admin/requests/:requestId/visibility` |
| `publicAt` | stamped alongside the opt-in |

They are separate on purpose. Hiding must not overwrite what the customer asked for, so
un-hiding restores their actual intent instead of guessing at it. **Everything published
before the wall existed stays private** — those customers were never offered the choice.

`isPublic` is written by a post-insert `UPDATE` in `routes/api.js`, placed immediately
after `requestQueue.add` and **before** `registerWebhook`. That ordering matters:
`webhook_manager.js` sleeps a deliberate 5 seconds between its two registrations, and a
crash on the far side of that await would lose the customer's choice silently — the order
completes, the message publishes, and it simply never reaches the wall.

It is deliberately *not* validated in `validateRequestParams`. That function guards the
money; wall visibility cannot make a transaction unbroadcastable, and mixing it in blurs
what that guard is for. It is type-checked at intake instead, and **rejected rather than
coerced** — `"false"` is a thing a caller might send meaning no.

Treasury-funded and free messages published through `routes/internal.js` create no
`requests` row at all, so they can never appear on the wall whatever `isPublic` says.

`GET /api/payment-qr.svg?requestId=…` is the one public use of `qr.js`. It takes **only**
a request id and reads the address, amount and label from the row. Do not add an
`?address=` parameter the way the admin route has one — public, that is an open QR
generator and an address oracle against the seed. It refuses once `archivedAt` **or**
`webhooksRetiredAt` is set: hooks retire at 62h and archiving is at 7 days, and in the
4.4 days between, nothing is watching that address except the customer's own open tab.

## Confirmation, and the failure nobody could see

Every reconcile pass filters `opReturnTxId IS NULL`, so until 2026-08-08 nothing in the
service ever looked at a transaction again once it was broadcast. `DEFAULT_FEE_RATE` is
2 sat/vB — the relay floor, and exactly the tier a full mempool evicts. So "we took the
money, broadcast, and it vanished" was an outcome the operator could not have detected.

`confirm_watch.js` runs every 5 minutes, asks Esplora whether published transactions have
been mined, and records `opReturnConfirmedAt` / `opReturnBlockHeight`. `alerts.js` turns
a prolonged absence into a warning.

Three rules hold it in place:

- **Esplora only, structurally.** There is deliberately no BlockCypher implementation of
  `getTxStatus`, so `tryProviders` filters BlockCypher out on method presence alone. A
  view path cannot spend the webhooks' allowance even by accident.
- **An unreadable answer is not a negative.** On any provider failure the row is left
  exactly as it was. Recording "not mined" because a host timed out is the same mistake as
  showing an unreadable balance as zero.
- **It is a UI signal and never a money decision.** A one-block reorg un-mines a
  transaction; if `refund.js` or `reconcile.js` ever branched on this column, a reorg would
  become a refund. `confirmations.js` asserts that no money path reads it.

The alert is bounded at **both** ends — older than the watcher's give-up window and it is
not "unconfirmed", it is unchecked, and a warning nothing can ever clear teaches the
operator to skip the panel.

It is deliberately **not** a new status value: `wall.js` filters on
`status = 'op_return_broadcasted'`, so an `op_return_confirmed` status would silently empty
the public wall of every message the moment it got mined.

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

## Retention: archive, never delete

A request row is the only record of what a customer asked for and which address they were
quoted. Deleting it makes a late payment unattributable — the wallet view sees money at a
derived address with nothing to explain it. Nothing is ever hard-deleted.

`archivedAt` marks a row dead. **`status` is deliberately left alone**, so it still says
how the order died; that is the part worth studying later. `archivedReason` is either
`cancelled_by_customer` or `abandoned_unpaid`.

Two deadlines, on purpose:

| At | What happens |
|---|---|
| 62h (`WEBHOOK_RETIRE_AFTER_MS`) | webhooks retired — two open hooks per abandoned order spend a quota the money paths need |
| 7 days (`REQUEST_ARCHIVE_AFTER_MS`) | one final chain check, then archive |
| 180 days (`REDACT_ARCHIVED_AFTER_MS`) | another chain check, then the content is dropped |

### Hooks you cannot see

`deleteWebhook` returns `undefined` on every path, so the database's idea of which hooks
are gone is a hope, not a fact. `listWebhooks` reads what BlockCypher actually holds.

`webhook_reconcile.js` holds the judgement, shared by the admin endpoints and the
scheduled sweep so the manual and automatic views can never disagree. A hook is
**orphaned** when nothing still needs it: no row claims it, or the row that does is
retired, archived or settled.

**A hook is matched by address as well as by id, and that is load-bearing.** `routes/api.js`
inserts the row, *then* calls `registerWebhook`, which sleeps five seconds between its two
registrations before either id is written back. For that window a live hook is claimed by
no row's id column. An id-only rule calls it orphaned and deletes the webhook watching a
customer who is about to pay. Addresses are `UNIQUE` per row and never reused, so matching
on them closes the window for nothing. Do not "simplify" this back to an id lookup.

Three layers, because none of them can see everything:

| Layer | Catches |
|---|---|
| retirement pass (62h, and settled at any age) | hooks whose row says they are finished with |
| `sweepOrphanedWebhooks`, same 6-hourly job | hooks BlockCypher still holds that no row needs — the only layer that can see a delete which silently failed |
| `GET`/`POST /api/admin/webhooks[/prune]` | the same thing, on demand, when a human wants to look |

**A teardown that could not be confirmed is never recorded as done.** The retirement pass
claims the row first (so a payment landing mid-pass stops it), then tears the hooks down
with `deleteWebhookIds` — awaited, and able to answer. If any delete fails, `webhooksRetiredAt`
is rolled back and the next pass retries. Leaving the stamp in place is precisely how a
hook goes live forever: the row says retired, so nothing ever looks at it again. The archive
pass stamps only on success for the same reason; the row is archived either way, and its
hooks fall to the sweep.

BlockCypher refuses deletes after roughly twenty in a burst — `"Limits reached."` — which
is exactly when a batch is being cleaned up. The scheduled sweep caps itself at 15 and
reports `remaining`; the manual prune is uncapped but stops the moment it sees a rate
limit rather than burning the quota it exists to protect.

The first real comparison, on 2026-08-07, found **24 hooks registered, 2 in use, 22
orphaned** — all belonging to rows hard-deleted before archiving existed. Hard deletion is
gone, so that source is closed; the sweep exists because the mechanism that *hid* it is
not. `WEBHOOK_SWEEP_ENABLED=false` turns it off.

**An address that turns out to hold money is not archived.** The amount, the txid and a
resolved refund address are written and a Telegram alert fires once; nothing automatic
touches it after that. Those writes are not cosmetic: the admin panel only renders its
Refund button for a row carrying a payment, and `refund.js` refuses outright when
`refundAddress` is null — without them the manual escape hatch would not exist.

Every write claims the row first and acts second, and carries all four money guards
(`paymentTxId`, `paymentReceivedSatoshis`, `opReturnTxId`, `refundTxId` all NULL). The old
code tore webhooks down *before* the guarded write, so a payment landing mid-pass left a
funded row whose hooks were already gone.

`webhooksRetiredAt` is a separate column rather than nulling `blockcypherHookId`:
`deleteWebhook` returns `undefined` on every path — missing token, 204, 404, network
error — so a deletion can never be confirmed, and discarding the id would throw away the
only handle to a possibly-live hook.

Because `status` survives archiving, **anything that keys on status alone must also check
`archivedAt IS NULL`** — the webhook matcher, the status endpoint, the cleanup candidate
query. Two queries must NOT be filtered: `alerts.js` and `reconcile.js` `reportStrandedFunds`
key on `paymentTxId` with no status predicate, and that is exactly what makes the 66-day
silent failure impossible to repeat.

Intake is rate limited (10/hour, 40/day per client address, API key exempt). With hard
deletion gone, that limiter is the only bound on the table.

### Redaction, at 180 days

The one irreversible operation in the service. It **redacts, it does not delete**: the row
keeps its index, address and derivation path, so a payment arriving years later is still
attributable and the wallet view can still explain money at a derived address. What goes
is the content — `message` (emptied, not nulled: it is `NOT NULL` in the original schema,
so `redactedAt` is the marker), `userFeedback`, `targetAddress`.

`request_events.detail` is cleared for the same request in the same pass. A feedback event
holds the customer's text verbatim and a created event holds the recipient address, so
redacting `requests` alone would leave both behind. Kind and timestamp survive.

Guarded like an archive and then some: archived only, no sign of money, past the horizon,
and **a fresh chain check first**. A funded address is reported through
`recordUnexpectedPayment` and left completely alone — if money arrived, the message is the
only record of what it was for. `REDACTION_ENABLED=false` turns it off.

What survives for study: `createdAt`, `status`, `archivedReason`, `feeRate`,
`amountToSend`, `requiredAmountSatoshis`, `messageBytes`.

## The event log

`request_events` is the durable history: `requestId, at, kind, detail`. `event_log.js` is a
different thing — an in-memory ring buffer of warnings, wiped on restart, not keyed by
request.

Two rules:

- **Writes never break or delay the caller.** Fire-and-forget, errors swallowed. This is
  called from the middle of building and broadcasting transactions.
- **Lifecycle transitions only.** The database is `journal_mode=delete` on the same
  serialized handle the money paths use, so every insert is its own fsync. Never record
  per poll, per scan, or inside a loop.

Read it with `GET /api/admin/requests/:id/events`.

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
`/home/admin/op_returner_tests/` — **390 assertions across eight files**, all offline:

- `unit_harness.js` — 91. Intake validation, builder guards, sizing, dust, Taproot,
  classification.
- `provider_fallback.js` — 12. Broadcast fallback, with `axios.post` stubbed.
- `webhook_forgery.js` — 28. Proves a forged notification cannot drive a row.
- `intake_rate_limit.js` — 13. Throttling, per-client buckets, API-key exemption.
- `archive_lifecycle.js` — 80. Archive-not-delete, funded-and-kept, retirement (pending
  and settled), the rollback when a teardown cannot be confirmed, events, redaction and
  its guards.
- `webhook_sweep.js` — 39. Orphan classification, the registration-in-flight window, prune
  honesty, the BlockCypher burst limit, `deleteWebhookIds`. BlockCypher stubbed at `axios`.
- `wall.js` — 91. What the wall shows and what it must never show, the public field
  whitelists, intake opt-in, moderation, the payment QR's refusals, and the ALTER-based
  upgrade path on a database that already exists.

- `confirmations.js` — 36. The confirmation watch, its bounds, the "unreadable is not
  unconfirmed" rule, the operator alert for a transaction that never got mined, and the
  invariant that no money path reads `opReturnConfirmedAt`.

`wall.js` lifts the candidate SQL **out of `reconcile.js` and executes it**, rather than
restating it. A restated copy keeps passing after somebody deletes the guard from the real
module, which is the one failure that section exists to catch.

Throwaway databases are built from `schema.js`, so a test schema can no longer drift from
production — that drift already broke a harness once, when `archivedAt` was added.

They all point at `/home/admin/webseiten/op_returner/backend/src` by absolute path, so they
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

Two more that have been checked this way, both worth re-checking if you touch webhooks:
dropping the address fallback in `judgeHook` turns a hook belonging to a live
`pending_payment` row into `"reason":"no request claims this hook","orphaned":true` — a
prune would delete the webhook watching a customer mid-payment. Removing the
`webhooksRetiredAt` rollback leaves `the next pass retries it — []`: nothing retries, and
the row claims a teardown that never happened.

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
