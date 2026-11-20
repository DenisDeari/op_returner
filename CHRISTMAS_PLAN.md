# SatWire Christmas — build plan

Written 2026-11-20 from a long design session with the operator. Nothing in `backend/src/`
has been touched yet. Read `CLAUDE.md` first; this file only adds what is specific to the
gift product. Everything under **Decided** is the operator's decision — do not reopen it.

## What it is

A painted A5 card that carries a personal message and a scratch-off QR code. The giver pays
with their own bitcoin; SatWire holds it; the recipient scans the code, picks Lightning or
on-chain, and receives it. At that moment the giver's message is published in an OP_RETURN.

The operator sells **the card**, for euros or sats. He does not sell bitcoin: the gift always
comes from the giver's own bitcoin. Holding the gift until it is claimed is custody; that
risk was raised once and the operator accepted it. Do not raise it again.

Christmas is deliberately **detached from normal SatWire**: its own pages, its own table,
and a gift message never appears on the public wall.

## Decided

| Topic | Decision |
|---|---|
| Model | Claim code: money is held, recipient redeems by scanning one QR code. No seed phrase on paper |
| Options | **A** — SatWire prints and posts the card. **B** — the giver prints it at home |
| Prices | A: 15 EUR + 2.50 EUR flat postage (Europe, provisional). B: 5 EUR |
| Paying | Either everything in bitcoin (one payment: gift + card price converted at the live rate), or the card by credit card (Stripe, EUR) and the gift in bitcoin. The order is complete when both parts are paid |
| Gift size | Maximum 1,000,000 sats. The draft uses a 25,000-sat minimum; not explicitly confirmed |
| Fee reserve | The giver chooses it at purchase — this is the existing `feeRate` chosen at intake, nothing new. Fees never come out of the gift |
| Redeemable from | The giver may pick a date; before it the code shows only "opens on …" |
| Expiry | The giver picks 1, 3, 6 or 12 months (maximum one year). After it the code stops working |
| Pull-back | Until the gift is claimed, the giver can lock it and take it back at any time from their order page. Expiry uses the same path. No message is published on a pull-back |
| Wall | Never. `isPublic` is always 0 for a gift |
| QR code | One code, under a scratch-off sticker. It is a personal link; the page recognises the gift, nothing is typed |
| Languages | German and English |
| Stripe | The Bubby account. Live key is in `.env` as `STRIPE_SECRET_KEY` (copied 2026-11-20, backup `.env.bak-20261120-stripe`). No test key exists: the rehearsal is a real 5 EUR payment, refunded afterwards |
| Treasury | The operator says float is not a constraint |

## The card

- A5 portrait (148 x 210 mm), flat, about 300 g, uncoated.
- **Side 1:** the artwork (120 x 170 mm inside a paper border) with the giver's message
  printed on it. The painter leaves a calm area of about 100 x 60 mm, wherever she likes.
  Theme: how a message is kept forever in the Bitcoin blockchain. Small "title · painted by"
  line in the bottom border.
- **Side 2:** a small ₿ ornament, three redeem steps, the scratch-off QR code, satwire.io.
- Dark green C5 envelope with a red ₿ seal.
- Because the message position is the painter's choice, each motif needs its own stored
  message box (x, y, width, height, text colour).

Production for option A is **not settled**. The message differs per card and sits on the
artwork, so cards cannot be fully pre-made. The operator's printer is a Brother MFC-J4340DW
inkjet (rear single-sheet slot, reportedly up to about 300 g — untested). Two candidates,
to be decided by a paper test:

1. Print shop pre-prints the artwork with the calm area almost unprinted; the operator
   overprints the message (side 1) and the QR code (side 2) per order.
2. The operator prints both sides per order at home.

Either way the server needs an **operator print page** (A5, both sides) per order, and
option B needs the same page for the giver. Use the browser's print function; this machine
has no rasteriser, so there is no server-side PDF.

## How it fits the existing code

A gift is an ordinary `requests` row with one new status, **`gift_held`**, between "paid"
and "publish". Every publishing and refund pass in `reconcile.js` selects rows by an
explicit list of statuses (`payment_confirmed`, `op_return_failed`, `processing_op_return`,
`refund_processing`, `refund_failed`), so a new status is on none of them.

On claim the row gets the recipient's destination and moves to `payment_confirmed`; the
existing, tested machinery does the rest. **No new transaction builder.**

| Paid | Claimed | What happens |
|---|---|---|
| on-chain | on-chain | `op_return_creator.js` spends the payment UTXO: OP_RETURN + recipient output (`targetAddress`, `amountToSend`), change to the operator |
| on-chain | Lightning | phoenixd pays the recipient; the payment UTXO publishes the message with `amountToSend = 0`, the rest becomes operator change |
| Lightning | on-chain | `fulfilLightning`: the treasury pays OP_RETURN + recipient output |
| Lightning | Lightning | phoenixd pays the recipient; the treasury publishes the message |

Facts checked in the code on 2026-11-20:

- Payment is recorded in `routes/webhook.js` (on-chain, sets `payment_confirmed` at one
  confirmation, then `fulfillRequest`) and `lightning.js` `recordPayment` (Lightning). Both
  need a branch: a gift row goes to `gift_held` and is **not** fulfilled.
- `reconcile.js` `reportStrandedFunds` and `alerts.js` select
  `paymentTxId IS NOT NULL AND opReturnTxId IS NULL AND refundTxId IS NULL`. A held gift
  matches. Both need a guard, or every held gift is reported as stranded money.
- Check `cleanup.js` (archive, webhook retirement at 62 h, redaction at 180 days — a gift can
  be held for a year and its message must survive until it is claimed or pulled back) and
  the admin views for the same assumption.
- `feeRate` is stored per row at intake, so the giver's reserve needs no new logic. The
  recipient's address type is unknown at purchase: price the recipient output at the largest
  size (43 vB, P2TR/P2WSH) and its dust limit (573).
- `lightning.js` already has `payLightningAddress`, `sendToAddress`, `createInvoice`,
  `getBalance`. Paying a recipient is the same shape as `attemptLightningRefund`: at most
  once, and an unknown outcome goes to a human. Decide whether the recipient gives a
  Lightning address only or may also paste an invoice (that would need a new phoenixd call).
- `TREASURY_MAX_SPEND_SATS` defaults to 250,000. A Lightning-paid gift claimed on-chain is a
  treasury spend, so it must be raised above 1,000,000 plus fees.
- `express.json` in `server.js` already keeps `req.rawBody`; a Stripe webhook can verify its
  signature without new middleware. Node in the container is v18.
- The EUR price needs a rate. The draft reads `https://mempool.space/api/v1/prices` in the
  browser; the server must fetch its own and fix the rate when it quotes.

## Phases

Everything sits behind `CHRISTMAS_ENABLED` (default off), so each phase can go live unseen.

1. **Hold.** `gifts` table (order token, code hash, motif, option, shipping address,
   redeemable-from, expiry, amounts, Stripe session, state) linked to a `requests` row;
   status `gift_held`; intake endpoint that validates and quotes before any address or
   invoice is shown; the payment branches; the guards listed above. Shipping addresses are
   personal data — redact them after the card is posted.
2. **Claim and pull-back.** Code generation, claim page, the four payout paths, the giver's
   lock-and-take-back (payout to the giver, no OP_RETURN; the card price is not returned),
   attempt limiting.
3. **Stripe.** One-time Checkout session for the card price (statement descriptor suffix
   SATWIRE), `POST /api/webhook/stripe` with signature check and an idempotency table, no
   SDK. Pass the key through `docker-compose.yml` (needs `docker compose up -d webapp`).
   SatWire needs its **own** webhook endpoint and signing secret in the Stripe dashboard;
   Bubby's secret belongs to Bubby's endpoint.
4. **Pages.** The real `/christmas` page from the draft, the giver's order page (bearer
   link, no e-mail system), the print pages, a Telegram message per paid option-A order,
   and "posted" marking for the operator.
5. **Rehearsal.** All four payout paths on mainnet with a 25,000-sat gift, the Stripe
   payment and refund, and a scratch-then-scan test on the printed card. Then switch on.

New test suite in `~/op_returner_tests/` for phases 1 and 2; the existing suites stay green.

## Invariants to add to CLAUDE.md as they are built

- Automation never publishes or refunds a held gift.
- A gift is claimed at most once — a conditional `UPDATE` is the lock, as in `refund.js`.
- The code is never stored in plaintext; only its hash. It must still be printable later, so
  derive it (HMAC of the gift id under a secret in `.env`) rather than storing it.
- Guessing is limited per client address (`http_hygiene.js` `clientIp`), never globally.
- A Lightning payout is paid at most once; an unknown outcome goes to a human.
- Fees never reduce the gift.
- Nothing is quoted before every economic parameter is validated.
- A Stripe webhook body is a doorbell: verified, then only triggers a lookup.
- A gift row is never on the wall.

## Deliberately left out

E-mail, server-side PDF, user accounts, automatic return at expiry (the giver pulls it back).

## Open

- Paper test: does the Brother take 300 g, and does a scratched QR code still scan?
- Which production route for option A (see *The card*).
- Final postage and countries; Impressum, privacy notice and withdrawal terms on the page.
- Which wallet app to recommend to recipients (test on the operator's phone).
- Lightning destination format at claim (address only, or invoice too).
- Message length: the draft allows 280 characters; the OP_RETURN size is part of the reserve.
- The artwork itself: the painter works from `/christmas/formats`.

## Where things are

| | |
|---|---|
| `frontend/christmas/entwurf.html` | The approved draft of the sales page (static, no backend). The operator said it looks great |
| `frontend/christmas/formats.html` | The painter's brief. Deliberately bare — the operator cut three richer versions |
| `tools/christmas_formats/` | Generator for the brief (`gen3.py`, `art.py`); writes `formats.html` into the current directory |
| Bubby's Stripe code | `~/code/snp/routers/subscriptions.py` on the operator's Mac — subscription mode, a pattern to follow, not code to reuse |
