# op_returner / SatWire — notes for future agents

Live Bitcoin service at <https://satwire.io>. A customer pays to an address we derive,
and we publish their message on-chain in an `OP_RETURN` output. **This code moves real
customer money.** Read this before changing anything under `backend/src/`.

## How to talk to the operator

Plain language. Short sentences. Say the essential thing first, then the detail.

The operator runs this service and makes the decisions; they do not need to be walked
through your reasoning to approve something. Lead with what is true and what it means for
them — "the limit is 20,000 bytes, that is about 42,000 sats for the biggest picture" —
not with the mechanism that produced it.

Concretely:

- **Answer first, evidence second.** If asked why something happened, say why in one
  sentence, then show the numbers.
- **Numbers over adjectives.** "1,500 bytes, 5,250 sats, 160×120" beats "quite small".
- **Name the cost in sats**, not in vBytes, whenever a person has to decide something.
- **Tables for anything with more than three values.** They get read; paragraphs do not.
- **Say what still needs doing, and what it would cost if skipped.** Ranked, not listed.
- **Flag the risk once, clearly, then do the work.** Do not re-raise a concern the
  operator has already decided on.
- **Never bury a problem in the middle.** If something broke, or you broke it, that goes
  at the top, in one sentence, without softening.

Jargon is fine when it is the actual name of a thing (`OP_RETURN`, dust limit, P2WSH).
It is not fine as a substitute for explaining what happened.

The operator may switch languages. Follow them, and keep the same plainness — a
translated wall of jargon is no better than the original.

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
| The OP_RETURN output size is computed, never hand-rolled from the payload length | `tx_sizing.js` `opReturnOutputVBytes`, used by `queue.js`, `op_return_creator.js`, `treasury.js` |
| Everything prices from the **on-chain** byte count, never the stored string | `payload.js` `byteLength`, called by `queue.js` and `routes/api.js` |
| A payload's bytes must match the media type it declares | `payload.js` `validate`, magic-byte sniff at intake |
| A payload is only ever rendered as an inert raster type from a closed allowlist | `frontend/js/app.js` `RENDERABLE_KINDS`, `frontend/admin/admin.js` |
| The effective fee rate is never below `MIN_EFFECTIVE_FEE_RATE` (2 sat/vB) | `config.js`, applied in `op_return_creator.js`, `refund.js` and `treasury.js` |
| The built transaction's fee clears the relay minimum for its *actual* signed size | `op_return_creator.js` and `treasury.js`, checked after `extractTransaction` |
| Outputs never exceed inputs — checked *before* signing | `op_return_creator.js` |
| A request that has any sign of payment is never deleted | `cleanup.js`, `routes/api.js` DELETE |
| Automation never publishes a message the customer withdrew | `reconcile.js`, `archivedAt IS NULL` on both publishing passes |
| An archived request is never on the public wall | `wall.js` `WALL_SELECT_SQL` |
| The wall listing never carries image bytes — they are fetched one at a time | `wall.js` `WALL_SELECT_SQL` CASE |
| The payload endpoint runs the listing's own predicate, from one shared string | `wall.js` `WALL_WHERE_SQL` |
| A payload URL is keyed on the txid, never on the request id (a bearer capability) | `wall.js` `WALL_PAYLOAD_SQL` |
| Every payload refusal is identical, so it cannot be used as a moderation oracle | `wall.js` `findPublicPayload` |
| A standardness rejection is one host's policy — ask them all; only `bad-txns-*` stops the chain | `chain_providers.js` `contested` |
| A public response is a whitelist, never a row spread | `wall.js`, `PUBLIC_REQUEST_FIELDS` in `routes/api.js` |
| A confirmation that could not be read is never recorded as "unconfirmed" | `confirm_watch.js` |
| `opReturnConfirmedAt` is a UI signal — no money path may read it | asserted in `confirmations.js` |
| A refund never runs twice — conditional `UPDATE` acts as the lock | `refund.js` |
| Never auto-refund when the payment UTXO is already spent | `NO_REFUND_FAILURES`, `reconcile.js` |
| The refund address comes from the chain, never from the webhook body | `routes/webhook.js` |
| The admin panel's image allowlist matches the wall's, and neither contains SVG | `IMAGE_KINDS` in `frontend/admin/admin.js`, asserted against `RENDERABLE_KINDS` |
| A block explorer being slow never hides the order behind it | `frontend/admin/admin.js` `showDetails` paints before it fetches |
| A notification carries the picture itself, in one Telegram call | `notifier.js` `sendPhoto` |
| A photo Telegram will not take falls back to text — silence is the worst outcome | `notifier.js` `fire` |
| A notification never throws into a money path, whatever the row holds | `notifier.js` `fire`, decode inside the promise |
| The fee surcharge shown to the customer equals the one the server charges | `frontend/js/app.js`, asserted against `queue.js` arithmetic |
| Nothing user-supplied reaches `innerHTML` unescaped | `frontend/admin/admin.js`, `frontend/js/app.js` |
| Wall text is rendered with `textContent`; a wall image is a DOM-built `<img>` — neither ever reaches the HTML parser | `frontend/js/app.js` `renderWall`, `payloadImage` |
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
| Plaintext HTTP is redirected, but **never** for a request with a body | `http_hygiene.js` `forceHttps` |
| A redirect only fires on an explicit `x-forwarded-proto: http` — never on a guess | `http_hygiene.js` `forceHttps` |
| A long `max-age` is only ever sent for a URL that changes when its bytes change | `http_hygiene.js` `staticCacheHeaders` |
| The admin panel is `noindex`, by header so it also covers `admin.js` | `http_hygiene.js` `noIndexAdmin` |
| A wall image reserves its height before the bytes arrive | `styles.css` `.payload-img` |
| The admin bearer token is `sessionStorage` only — never `localStorage` | `frontend/admin/admin.js` |
| A rejected admin token is thrown away centrally, not at 14 call sites | `frontend/admin/admin.js`, shadowed `fetch` |

A fee at exactly 1 sat/vByte sits on the minimum relay fee and providers reject it as
`non standard: low fee rate`. That is why the floor is 2, not 1. The extra always comes
out of the service fee, never out of what the customer is charged.

## Layout

```
backend/src/
  routes/api.js         intake validation, status polling, feedback, the wall, payment QR
  payload.js            what goes in the OP_RETURN and how big it is — text or image
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

`frontend/js/app.js` mirrors this arithmetic to preview the cost, to name the minimum next
to the amount field, and to run the image budget search. It recognises types by address prefix rather than decoding —
it only drives a preview, and the server remains the authority — but if you change
`tx_sizing.js`, change it there too or the quote will not match what was displayed.

Three details in that mirror are load-bearing. `opReturnOutputVBytes` must match
`tx_sizing.js` exactly — `image_payloads.js` asserts it across 0..12000 bytes, because the
budget search picks a payload size from a price and a disagreement means the browser targets
a size the server charges differently. The other two survived the 2026-08-08 rebuild verbatim:
the `bc1p` test must come **before** the `bc1q` one (a P2TR address is also 62 characters,
so a single "bc1" branch under-quotes both P2WSH and P2TR by 12 vBytes), and the amount
hint must keep naming the real minimum out loud. Parity was checked against
`tx_sizing.js` across all six address types after the rebuild; re-run that check if you
touch either side.

## Image payloads

A customer can publish a picture instead of text. The browser resizes and re-encodes it to
WebP (JPEG where WebP encoding is unavailable), the row stores **base64**, and the chain
gets the **decoded bytes**. `payload.js` is the single source of truth for both.

**The stored length is not the on-chain length.** That is new — before images, `message`
was the payload, and `Buffer.byteLength(message)` answered both questions. For an image row
it answers neither: base64 is 33% larger. Anything that quotes, validates or builds must go
through `payload.byteLength()`. Pricing the stored string overcharges every image customer
by a third; the reverse under-quotes, which is the failure the top of this file is about.

**There is no envelope and no magic prefix of our own.** WebP and JPEG are self-identifying
(`RIFF….WEBP`, `FFD8FF`), so anyone can pull the OP_RETURN data out of the transaction and
get a complete, valid image file — verified by a byte-identical round trip through nothing
but a hex decode. A prefix would cost the customer real sats to encode a convention only we
understand. `payloadKind` on the row is for our own rendering, not for the chain.

`payloadKind` is NULL on every row written before this existed, and NULL means text. That is
deliberate and must not be backfilled: NULL already carries the right meaning.

### Sizing, corrected

`tx_sizing.js` `opReturnOutputVBytes()` is now the only place the OP_RETURN output is
measured. Three modules used to hand-roll it and **all three were wrong past 75 bytes**:

| Where | Old form | Under-counted by |
|---|---|---|
| `queue.js` | `11 + messageBytes` | up to 4 vBytes, no safety margin |
| `op_return_creator.js` | `script.length + 9` | 2 vBytes, absorbed by `FEE_SAFETY_VBYTES` |
| `treasury.js` | `script.length + 9` | 2 vBytes, **and it has no safety margin at all** |

Both assume a one-byte push prefix and a one-byte script varint. Neither holds once a
payload passes 75 bytes (the push widens) or a script passes 252 (the varint widens). At the
64-byte messages this service had actually published, every one of them was exactly right —
the same shape as the 2026-08-06 bug: an assumption true for the common case, silently false
for a new one. The treasury one was live and reachable at `max_payload_size` 1000.

### The wall never carries image bytes

`GET /api/wall` returns **no payload for an image row** — the `CASE` in `WALL_SELECT_SQL`
keeps it out of the result set entirely. The card gets an `opReturnTxId` and the browser
fetches the picture from `GET /api/wall/payload/:opReturnTxId`.

It used to inline the base64. At the 20,000-byte limit that is ~27 kB of JSON per image and
over a megabyte for a full page of 50 — unauthenticated, uncompressed, and deliberately
un-rate-limited, on every single homepage visit.

Three things make the split safe, and all three must stay:

- **`WALL_WHERE_SQL` is one string, used by both queries.** There are now two places that
  decide whether a customer's picture is public, and the listing is the one a human looks
  at. A payload endpoint with a weaker predicate would serve the bytes of a message the
  operator had hidden or the customer had withdrawn while the listing correctly refused to
  mention it — a silent leak behind a visible guard. `wall_image_render.js` reintroduces
  exactly that bug and checks it fails.
- **Keyed on `opReturnTxId`, never the request id.** A request id is a bearer capability
  (`GET /api/request-status/:id` is public), so putting one in a URL the homepage emits
  would hand every visitor read access to that order. A txid is already public.
- **Every refusal is an identical 404.** Distinguishing "no such transaction" from "hidden
  by the operator" turns the endpoint into an oracle for moderation decisions.

The endpoint serves **decoded bytes with a `Content-Type` from our own enum**, plus
`nosniff`. That is both smaller than base64 and safer than the `data:` URL it replaced —
the frontend no longer builds a URL out of customer content at all.

`cachedAt` moved from the JSON body to the `X-Wall-Cached-At` header. In the body it changed
every 10 seconds even when nothing was published, so the ETag differed on every request and
every open tab re-downloaded the whole listing once a minute.

### Rendering somebody else's picture

The rule that kept the text wall safe — `textContent`, never `innerHTML` — does not extend
to an image. What replaces it, on both the public wall and the admin panel:

- **A closed allowlist of media types.** The `data:` URL's type comes from that constant,
  never from the row. Interpolating a server-supplied type is how `data:text/html` ends up
  rendering on the origin that also serves `/admin`.
- **Base64 is re-validated client-side** before the string is concatenated into a URL.
- **The element is built with DOM calls and appended**, never interpolated into an
  `innerHTML` template, so the payload never reaches the HTML parser.
- **Anything unexpected renders nothing** and falls back to a text description.

**Never add `image/svg+xml`.** It is tempting — SVG is already text, so it costs no base64
overhead, and a minified logo is ~300 bytes. It is also markup carrying `<script>` and
`<foreignObject>`. The server refuses it at intake and the frontend refuses it at render;
both sides have to keep refusing it.

### The limits, and which one actually bites

Four ceilings sit on top of each other. The lowest wins.

| Ceiling | Value | Where |
|---|---|---|
| Text | 1,000 bytes | `system_settings.max_payload_size` |
| Image | **20,000 bytes** live | `system_settings.max_image_payload_size` |
| Builder backstop | 20,000 bytes | `op_return_creator.js` `MAX_ON_CHAIN_PAYLOAD_BYTES` |
| Browser encoder | 1024 px longest edge | `frontend/js/app.js` `IMAGE_SIZES` |
| Bitcoin standardness | 100,000 bytes | Core v30 default, not our constraint |

`POST /api/admin/config/limits` sets the first two and **clamps both against the builder
backstop**. That clamp is not optional: a settings value above it would be quoted to a
customer and then refused by the builder *after they had paid*.

**`database.js` seeds `max_image_payload_size` at 2,000, not 20,000.** Production was raised
to 20,000 by hand and that is the live value; a *fresh* database gets 2,000, and the admin
panel has no control for this key — `frontend/admin/index.html` exposes only the text limit,
and `admin.js` POSTs only `maxPayloadSize`. So a rebuilt database silently caps images at a
tenth of what this document describes, and the only way to raise it is the API directly. Read
the row before trusting either number.

**In practice the picture usually runs out before the bytes do.** Most photos at 1024 px
land well under 20,000 bytes, so the encoder's ladder is the binding limit, not the setting.
The budget slider stops at whichever bites first and says which one it was.

What a budget buys, at 2 sat/vB (WebP, measured on a detailed 4000×3000 photo):

| Image | Bytes | Total |
|---|---|---|
| 96×72 | ~850 | ~3,950 sats |
| 160×120 | ~1,500 | ~5,250 sats |
| 256×192 | ~2,840 | ~7,930 sats |
| 512×384 | ~7,880 | ~18,000 sats |
| 1024×768 | ~20,000 | ~42,250 sats |

### Resolution first, quality second

`encodeWithin` walks the size ladder largest-first and takes **the first size that fits at
all**. The binary search inside a rung already finds the best quality that size can afford,
so the result is the biggest picture the budget buys and then the sharpest version of it.

There used to be a quality gate — a size was only accepted at quality >= 0.4, on the
reasoning that a smeared big picture reads worse than a clean small one. **That gate cost a
customer 41,890 sats on 2026-08-09.** A high-resolution iPhone photo with a ~19,900-byte
budget could have been 800x600 at quality 0.22; the gate rejected it, rejected 640x480 at
0.30 and 512x384 at 0.38, and returned 400x300 at 0.92 — spending the whole budget on
quality nobody asked for, at a quarter of the picture. The customer had asked for the
smallest format at the highest resolution and got exactly the opposite trade.

Do not reintroduce it. Whether a softer 800x600 beats a crisp 400x300 is a judgement about
someone else's picture and someone else's money; the composer shows the result and says when
compression was heavy, and the customer decides by looking. A threshold in here cannot.

The ladder tops at 1024 px and never upscales, so a small source stays its own size — rungs
above it are skipped rather than re-encoded to the identical canvas.

**Every browser gets WebP, and that took two goes to get right.** JPEG is roughly twice the
size of WebP at these rungs — a fixed header cost that barely shrinks as the image does — so
a browser without native WebP encoding used to cost the customer DOUBLE for the same picture.
That happened for real on 2026-08-09: an 18,522-byte JPEG quoted at 39,292 sats, where WebP
would have been about half. The order was stopped before publication and refunded.

The mistake was not the fallback, it was the reasoning. Keeping image decoding off the server
is correct — a decoder exploit on the machine holding the wallet seed is the worst outcome
this service has. But "not on the server" was quietly implemented as "whatever
`canvas.toBlob` happens to support", and a browser limitation became a product limitation.

`frontend/vendor/webp/` now carries libwebp compiled to WebAssembly (@jsquash/webp 1.5.0,
Apache-2.0, Google's Squoosh build), so the encoder no longer depends on the browser having
one. The security property is unchanged: it runs in the customer's browser, in the WASM
sandbox, and touches nothing of ours. Preference order is native WebP → WASM WebP → JPEG,
and the last one should now be unreachable.

Three things about that directory:

- **The `.js` and its `.wasm` must stay side by side.** The emscripten module resolves its
  own wasm relative to its own URL. Separating them fails only in a real browser.
- **It is loaded lazily**, on the first image, not at page load — it is ~280 kB on a page
  whose job is to show a wall of messages.
- **The files are pinned by SHA-256** in `image_payloads.js` and in `SHA256SUMS`. It is
  third-party binary code in a repository that moves money; its identity is checked, not
  assumed. Only `encoder.js` is ours.

`canvas.toBlob` is also what the native-support probe uses. It used to probe with
`toDataURL` and encode with `toBlob` — two separate implementations in every engine, allowed
to disagree — so the answer could simply be wrong. The probe checks `blob.type`, because a
browser that cannot produce a format does not throw, it silently returns PNG.

### The part that is still unproven

**The largest OP_RETURN this service has ever broadcast is 64 bytes.** Every published
message predates Core v30. Whether BlockCypher — first in the broadcast order — relays a
multi-kilobyte OP_RETURN is untested, and it has already shown it applies stricter rules
than the Esplora hosts.

Two things reduce the blast radius, and neither replaces an actual test:

- A `datacarrier` rejection is now **contested**, so all three hosts are asked before it
  counts (see *Error classification*). Before that fix, BlockCypher alone could veto a
  transaction the others would have taken, and it refunded.
- `confirm_watch.js` reports a transaction that broadcast but never got mined.

Knots nodes still reject payloads over 83 bytes, which costs propagation but not validity.
A multi-kilobyte transaction at the 2 sat/vB default is also a much bigger bet on the
mempool than a 250-byte one.

**The safe way to test is the treasury**, not a customer order: `POST /api/internal/embed`
is API-key-only and spends from `m/84'/0'/0'/2/0`, so no customer money is involved. It is
text-only and bound by `max_payload_size` today — and raising *that* to run a probe would
silently raise the **public text intake limit**, which is why the image limit is a separate
key. A probe path needs its own setting, not a borrowed one.

The frontend inverts this: the customer picks a sat budget and the encoder binary-searches
quality and dimensions to fit. That search calls the same `opReturnOutputVBytes` mirror the
cost preview uses, so **the parity requirement below is sharper than it was for addresses** —
the browser is choosing a payload size from a price, and a mismatch means the encoder targets
a size the server prices differently.

Encoding happens entirely in the browser, and that is a security decision, not a convenience
one: no upload endpoint, no temp files, and no image decoder parsing hostile input on the
machine holding the wallet seed. It also strips EXIF for free — phone photos carry GPS, and
this is a permanent public ledger.

## What the fee slider costs

**2026-08-11 — an order quoted at 124,970 sats, of which 97,576 was one slider.** A customer
attached a 12,038-byte picture, set a 1,000-sat payout to their own exchange deposit address,
and dragged the fee control to 10 sat/vB. They did not pay.

The arithmetic is not in dispute — `queue.js` priced it correctly:

| Term | vBytes | At 2 sat/vB | At 10 sat/vB |
|---|---|---|---|
| OP_RETURN output (12,038 bytes) | 12,053 | | |
| Recipient output (P2PKH) | 34 | | |
| Input, change, overhead | 109.5 | | |
| **Transaction** | **12,197** | 24,394 | 121,970 |
| Service fee | | 2,000 | 2,000 |
| To the recipient | | 1,000 | 1,000 |
| **Total** | | **27,394** | **124,970** |

The rate multiplies the *whole* transaction. On a 200-byte message a step is worth ~250 sats
and nobody notices; on a 12 kB picture it is ~12,000, and the slider is the most expensive
control on the page while looking like the most incidental. Both numbers were already on
screen — the total updated live, and the breakdown had the split. What was missing was the
link between the control and the number.

Three things now say it out loud, and none of them changes what is POSTed:

- **The chip carries the surcharge**, not just the drawer. The drawer is `grid-template-rows:
  0fr` until somebody clicks it, and a warning nobody opens is not a warning. It is hidden
  entirely at the minimum rate so it is never a permanent scold.
- **The surcharge is `quoteSats(bytes, MIN_FEE, …)` subtracted from the total**, never
  `totalN.textContent` — that element is written from inside a `requestAnimationFrame` and is
  mid-animation whenever `recalc` runs.
- **An entered payout amount is shown against what publishing costs**: "1,000 sats reach that
  address. 123,970 sats publish your message." The dust warning still wins when it applies —
  that is the one that would actually block a payment.

`MIN_FEE` comes from `/api/config/limits`, which has always sent `minFeeRate` and which the
page always threw away, keeping a hardcoded 2 in the markup instead. It now also drives
`feeIn.min`, so raising `MIN_FEE_RATE` server-side can no longer leave a slider offering a
rate that intake rejects.

**`Math.ceil(vb) * rate`, never `Math.ceil(vb * rate)`.** `queue.js` rounds the vBytes up
before multiplying. The two differ by a few sats, and `operator_view.js` asserts the frontend
surcharge equals the backend one across all six address types — reintroducing the wrong order
fails it.

The recipient field was relabelled in the same pass. "Also pay a Bitcoin address — optional"
read, to this customer, as a way to send bitcoin somewhere: they filled in an exchange deposit
address, screenshotted that same deposit page as their message, and set the fee high the way
you would to make a payment arrive quickly. The wording now leads with what the field is.

## What the operator can see

The operator moderates this service by reading Telegram and opening the admin panel. Until
2026-08-11 an image order reached both as `[WebP image, 12038 bytes]` — a string that says
nothing about whether the picture belongs on a permanent public ledger.

### Telegram gets the picture

`notifier.js` `sendPhoto` uploads the decoded bytes with the caption attached, for all four
lifecycle notifications that hold a payload (new order, payment received, delivered, failed).

- **One call, not two.** The caption *replaces* the text message rather than following it.
  `withinRateLimit()` is a global hourly cap shared by every notification type, so a photo
  sent as a second call would halve how many orders the operator hears about in a busy hour.
- **Everything that can fail is decided before a rate-limit slot is spent** — not an image,
  caption over Telegram's 1,024 characters, undecodable base64. A photo we then fail to send
  must not cost the operator the text message that replaces it.
- **An over-long caption falls back rather than truncating.** Cutting HTML mid-tag turns a
  length problem into a parse error, and Telegram rejects the whole message.
- **The decode happens inside `fire`'s promise.** `payload.decode()` throws on a row that does
  not decode, and `notifyDelivered` is called from inside `request_service.js`'s fulfil path,
  whose catch turns any throw into `{ success: false }` — *after* the OP_RETURN was broadcast.
  Evaluating it in the argument expression would make a corrupt row look like a failed order.
- **Anything at all going wrong sends the text instead.** A picture Telegram will not take is
  worse than plain text; silence is worse than both.

**The multipart body is built by hand.** The container runs Node 18, where `File` is not a
global and `require('node:buffer').File` prints an ExperimentalWarning — and axios only emits
`filename="…"` when a part carries a `.name`, which Telegram needs or it reads the part as a
plain string field instead of an upload. That was a choice between an experimental API and
twenty legible lines; in a repository that moves money, the twenty lines win. Do not
`require('form-data')` either: it exists under `backend/node_modules` only because axios
depends on it, it is not in `package.json`, and one `npm install` reshuffle would break a
module the money paths import.

### The admin panel shows it in the row

A thumbnail is appended to the payload cell after the `innerHTML` assignment — never
interpolated into it. `renderRequests` is one big template string, and this is the one origin
in the service holding a bearer token; the payload must not pass through the HTML parser here.
It goes through the same `imageElement` the details modal uses, so a row claiming
`image/svg+xml` renders nothing on both surfaces.

`IMAGE_KINDS` in `frontend/admin/admin.js` is a **second copy** of the wall's
`RENDERABLE_KINDS`. `operator_view.js` asserts the two are identical and that neither contains
SVG — previously only the public one was tested, and the admin one is the more dangerous half.

**A slow block explorer no longer hides the order.** `showDetails` used to build the whole
modal inside the same `try` as an awaited BlockCypher lookup, whose catch replaced the body
with one red line: a provider timeout took the customer's picture, their payment figures and
their refund address with it. The modal is now painted first and the lookup fills its own slot,
guarded by `histSlot.isConnected` so a late answer cannot land under a different order.

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

### The preview dialog

The thumbnail opens a larger preview with the budget slider under it, so the customer judges
the actual picture before paying rather than a 96-pixel square.

**The slider is MOVED into the dialog, not copied.** `#img-budget-row` is appended to
`#imgview-slot` on open and back to `#img-budget-home` on close, carrying its listeners with
it. Two synced inputs would be two sources of truth for one number, and the one being
dragged could drift from the one actually driving the encode. `closeImageView` must run
before the dialog is hidden, or the only control ends up inside a hidden element.

The dialog computes nothing: `syncImageView` copies the composer's own strings across, so
the two can never describe different images.

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

**Consensus vs policy is the line that decides whether the fallback runs.** A `bad-txns-*`
rejection breaks a consensus rule: every node agrees, so the first host to say so has told
the whole truth and we stop. Everything else in `PERMANENT_ERROR_PATTERNS` is *standardness*
— dust, `datacarrier`, `scriptpubkey` — which each node operator **configures**. One host's
refusal there is an opinion, not a verdict, so all of them get asked and only unanimous
refusal is final. `classifyError` returns `contested` for that case.

`datacarrier` is the one that matters now. Core v30 raised the default OP_RETURN limit from
83 bytes to 100,000 and kept it configurable; Knots keeps the old limit. So the same
transaction is standard to one host and non-standard to the next, right now, by deliberate
choice. Without the contested rule, a BlockCypher `datacarrier` rejection would stop the
chain dead and auto-refund an order both Esplora hosts would have taken — 2026-08-06 exactly,
with a different reason string. `datacarrier` and `multi-op-return` are also in the permanent
list at all now: a bare `datacarrier` reply previously matched nothing and read as
*transient*, so the request retried to `MAX_FULFILL_ATTEMPTS` against a limit that cannot
change between attempts.

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

## How the site is served

**2026-08-12 — `http://satwire.io/` answered 200 with the whole page and no redirect.** Found
by audit, never exploited. On a page whose entire job is to display a Bitcoin address a
customer then pays, a plaintext leg is something anything on the path can rewrite. There was
also no `Strict-Transport-Security`, so a browser had no reason to prefer TLS next time.

`http_hygiene.js` holds the three middlewares that now sit in front of everything. They live
in their own module for one reason: **requiring `server.js` opens the production database and
binds a port**, so nothing declared inside it can be tested. Same reasoning as `schema.js`.

Three details in `forceHttps` are load-bearing:

- **Only `GET` and `HEAD` are redirected.** A 301 is allowed to drop a request body, and
  `routes/webhook.js` receives unauthenticated BlockCypher POSTs — losing one loses a
  customer's payment event.
- **Only an explicit `x-forwarded-proto: http` redirects.** Absent, empty, `HTTP`, or a
  comma-joined list all mean *we do not know*, and guessing wrong is a redirect loop that
  takes the site down. Cloudflare's tunnel sets the header; nothing else is trusted.
- **HSTS goes out only over https**, without `preload` and without `includeSubDomains`. Both
  are far harder to walk back than they are to turn on.

**Caching is decided per request, from the query string — not per file type.** Assets are
versioned by hand (`app.js?v=13`), so a long `max-age` is correct for a URL carrying `?v=`
and for the SHA-pinned codec under `/vendor/`, and wrong for everything else: an unversioned
file cached for a week is a file you cannot fix for a week. HTML is never long-cached
whatever the URL says — `index.html` is what carries the next `?v=N`.

**`robots.txt` is Cloudflare's, not ours.** The origin 404s on it; the edge injects a
1,248-byte Content Signals file with zero actual directives, which under RFC 9309 means
everything is allowed. That is the right policy here, so there is deliberately no
`robots.txt` in the repo. **Do not add a `Disallow: /admin`** — that file is public, so the
line advertises the path to exactly the scrapers it is meant to hide it from, and no scanner
reads it anyway. `noIndexAdmin` sends `X-Robots-Tag` instead, as a header so it covers
`admin.js` and not just the HTML.

Neither of those is a security control. The one that is went in on **2026-08-12**: a Cloudflare
Access application now covers `satwire.io/admin`, so `/admin`, `/admin/` and `/admin/admin.js`
all 302 to a Cloudflare login. Anonymously fetching `admin.js` returns 0 matches for
`requireAdmin`, `adminPassword` or the refund route, where it used to return 51 kB of source.

### Access does NOT cover the admin API, and that is deliberate

`/api/admin/*` is **not** in the Access application. Putting it there would hand the panel's own
`fetch()` calls a Cloudflare login page instead of JSON. So:

**The bearer password is still the only thing in front of every endpoint that moves money.**
`GET /api/admin/requests` answers `401` to an anonymous request and does *not* redirect —
that 401 is the password, not Access. Access locks the anteroom; the password locks the safe.
Do not "simplify" it away because Access exists.

The token is kept in **`sessionStorage`, never `localStorage`**. The value stored is the admin
password itself — it is sent verbatim as the bearer — so this is a real choice, not a detail.
It survives a reload, which was the actual annoyance, and is never shared between tabs or synced
between machines.

**It is not, however, "gone when you close the browser".** Chrome and Firefox both write
sessionStorage into the browser profile so that tab restore and crash recovery work, so the
password can sit there in cleartext and can come back after a restart. localStorage would still
be worse — permanent and shared across every tab — but do not restate the stronger claim. The
**Forget password** button is what actually drops it, and it blanks the panel too: customer
messages, payload thumbnails, derived addresses and wallet balances are already rendered, and
they are exactly what you are trying not to leave up.

**A guard that returns silently is worse than no guard.** `fetchAlerts` and the wallet scanner
both used to `return;` when there was no token, above the button-disable and above every write —
so the Refresh button did nothing and the previous alert list stayed on screen. A panel whose job
is showing stranded customer money must not assert "all clear" from a stale render.

**A rejected token is cleared in one place.** 14 call sites send the token and exactly two ever
looked at a `401`. That was survivable while the token lived in memory and died on reload;
persisting it means a mistyped or rotated password would stick and the other 12 calls would fail
silently for as long as the tab stayed open. `fetch` is therefore **shadowed inside the
`DOMContentLoaded` closure** — `window.fetch` is untouched — and forgets the token on any `401`
whose URL contains `/api/admin`. A 401 from anywhere else means nothing about this password and
is ignored. If you add a call site, you get this for free; if you replace the shadow with the
global, you lose it silently.

`?v=N` on `admin.js` and `admin.css` must be bumped whenever either changes. They are now
long-cached like every other versioned URL, and Cloudflare caches them at the edge too — a
change without a bump is invisible for a week. That has already happened once: after the
2026-08-12 deploy the edge still served `admin.js?v=2` with the pre-deploy headers, and bumping
the version was the fix that needed no dashboard.

## What the page says it is

Until 2026-08-12 the page had 149 indexable words and the strings `blockchain`, `OP_RETURN`
and `on-chain` appeared **zero** times. It could not rank for what it does because it did not
say what it does. The wall does not help: it is rendered by JavaScript from `/api/wall`, so a
crawler that does not execute scripts saw nothing of it.

What was added, all static:

| | |
|---|---|
| `<title>` / description / `h1` | now name Bitcoin, the blockchain and `OP_RETURN` |
| A "What SatWire does" section | ~500 words: what it is, a price table, five steps, six Q&A |
| `<noscript>` | a visitor with JS off gets a sentence instead of a dead form |
| canonical, Open Graph, Twitter tags | a shared link produced no card at all before |
| `favicon.svg` / `.png` / `apple-touch-icon.png` / `og.png` | `/favicon.ico` was a 404 on every visit |
| JSON-LD `WebApplication` | no rich result — Google wants a rating for that, and inventing one is a lie |

**Every number in that prose is real** and `site_delivery.js` is not what keeps it that way —
a human is. The limits come from `/api/config/limits` and the picture sizes from the measured
ladder in *Image payloads* above. The JSON-LD states only the 2,000-sat service fee, because
the network fee on top depends on the mempool and a `price` the service cannot hold would be
a lie in machine-readable form.

The PNG assets are generated by `tools/render_icons.py` and `tools/render_og.py`, which draw
the mark from `frontend/favicon.svg` as geometry and encode it with `zlib` — this machine has
no rasteriser, no ImageMagick and no headless browser. `tools/` sits outside `frontend/` on
purpose: `express.static` serves that directory and nothing else should end up in it.

**`?v=N` must be bumped on both the CSS and the JS whenever either changes**, or a returning
visitor keeps the old file for a week now that versioned URLs are cached.

## Testing

There is no test runner in the repo. Verification lives outside it, in
`/home/admin/op_returner_tests/` — **713 assertions across twelve files**, all offline:

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
- `image_payloads.js` — 96. OP_RETURN sizing against bitcoinjs at every encoding boundary,
  stored-vs-on-chain length, quote/build agreement, estimate-never-below-real-signed-size,
  the magic-byte match, strict base64, the frontend mirror, and the treasury path's fee floor
  and relay check.
- `wall_image_render.js` — 45. The listing carries no image bytes; the payload endpoint
  refuses every row the listing refuses (hidden, archived, un-stamped, redacted, text);
  every refusal is an identical null so it is not an oracle; both queries are built from the
  same `WALL_WHERE_SQL`; and the **shipped** `wallImage` from `frontend/js/app.js` builds the
  right URL. Uses `fixtures/sample_200x200.webp`.
- `operator_view.js` — 105. What the operator and the customer can actually see: the
  hand-rolled multipart body byte for byte, every refusal `sendPhoto` makes before spending a
  rate-limit slot, one Telegram call per notification, the text fallback, the admin panel's
  allowlist checked against the wall's, the thumbnail being appended rather than interpolated,
  the details modal painting before the block explorer is asked, and the fee surcharge shown
  matching the one `queue.js` charges across all six address types, and the admin token being
  remembered in sessionStorage, restored on reload, and thrown away on a 401 from the admin API
  but not from anywhere else. `axios.post` is stubbed before `notifier.js` is required.
- `site_delivery.js` — 77. How the site is served and what it says about itself: the HTTPS
  redirect and the three things it must never do, HSTS only over TLS, the admin `noindex`, the
  cache rule for versioned versus unversioned URLs, the head tags, the real dimensions of the
  shipped `og.png`, that the JSON-LD parses and states only a price the service can hold, the
  wall's ETag gating, and the reserved image height. Reads the shipped files off disk.

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

Three more that have been checked this way. Dropping `WALL_WHERE_SQL` from `WALL_PAYLOAD_SQL`
— leaving the payload endpoint with only `status = 'op_return_broadcasted'` — makes
`wall_image_render.js` fail 13 assertions and print `"LEAK"` for the operator-hidden row.
The other two are worth re-checking if you touch webhooks:
dropping the address fallback in `judgeHook` turns a hook belonging to a live
`pending_payment` row into `"reason":"no request claims this hook","orphaned":true` — a
prune would delete the webhook watching a customer mid-payment. Removing the
`webhooksRetiredAt` rollback leaves `the next pass retries it — []`: nothing retries, and
the row claims a teardown that never happened.

Four more, all checked this way against `operator_view.js`. Dropping the text fallback from
`notifier.js` `fire` means a Telegram photo rejection produces **no notification at all**.
Restoring the awaited lookup at the top of `showDetails` makes the modal stop painting before
the block explorer answers. Changing the frontend quote to `Math.ceil(vb * rate)` puts the
surcharge shown 4 sats away from the one charged. Adding `image/svg+xml` to the admin panel's
`IMAGE_KINDS` breaks three assertions at once, including the one binding it to the wall's list.

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
