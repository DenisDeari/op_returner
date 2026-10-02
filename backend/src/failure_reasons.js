// backend/src/failure_reasons.js
//
// Which fulfilment failures can never succeed on a retry, and which mean the money may
// already have left. Lives on its own so lightning.js can ask the same question as
// reconcile.js without requiring it (reconcile requires request_service, which requires
// lightning — a cycle). reconcile.js re-exports both functions unchanged.

/**
 * Failure reasons that no amount of retrying will fix. Mirrors the permanent sets in
 * op_return_creator.js and treasury.js, matched by prefix since failureReason carries a
 * detail suffix.
 */
const PERMANENT_PREFIXES = [
    'invalid_message',
    'missing_payment_details',
    'insufficient_payment',
    'invalid_target_address',
    'change_derivation_failed',
    'key_derivation_failed',
    'signature_validation_failed',
    'broadcast_rejected',
    'fee_below_relay_minimum',
    'inputs_already_spent',
    // treasury.js. A spend over the per-transaction ceiling is refused before signing and
    // stays refused; the same request id carrying different content is an upstream bug.
    'exceeds_max_spend',
    'idempotency_key_reused',
];

/**
 * Failures where the money may already be gone, or the message already published, so an
 * automatic refund must not run. A human looks first.
 *
 *   inputs_already_spent     the customer's payment UTXO was spent — probably by an
 *                            earlier attempt that did publish.
 *   treasury_tx_unresolved   a Lightning order's treasury transaction was signed and may
 *                            have been broadcast, and the chain could not say which. It is
 *                            NOT permanent: retries re-send the same bytes and ask again,
 *                            and only a human decides once the attempts run out.
 */
const NO_REFUND_PREFIXES = ['inputs_already_spent', 'treasury_tx_unresolved'];

function isPermanentReason(reason) {
    if (!reason) return false;
    return PERMANENT_PREFIXES.some((p) => String(reason).startsWith(p));
}

function isNoRefundReason(reason) {
    if (!reason) return false;
    return NO_REFUND_PREFIXES.some((p) => String(reason).startsWith(p));
}

module.exports = { PERMANENT_PREFIXES, NO_REFUND_PREFIXES, isPermanentReason, isNoRefundReason };
