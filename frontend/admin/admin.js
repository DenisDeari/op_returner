// frontend/admin/admin.js
document.addEventListener('DOMContentLoaded', () => {
    const requestsBody = document.getElementById('requests-body');
    const modal = document.getElementById('detail-modal');
    const modalBody = document.getElementById('modal-body');
    const closeButton = document.querySelector('.close-button');
    const refreshButton = document.getElementById('refresh-button');
    const refreshBalancesBtn = document.getElementById('refresh-balances-btn');
    const refreshAlertsBtn = document.getElementById('refresh-alerts-btn');
    const alertsBody = document.getElementById('alerts-body');
    const alertsBadge = document.getElementById('alerts-badge');
    const eventLogBody = document.getElementById('event-log-body');

    // Config Elements
    const maxPayloadInput = document.getElementById('max-payload-input');
    const saveConfigBtn = document.getElementById('save-config-btn');

    const API_BASE_URL = '/api/admin';
    let adminPassword = null;
    let allRequests = []; // Store requests locally

    // Load initial config (public)
    fetch('/api/config/limits')
        .then(res => res.json())
        .then(data => {
            if (data.maxPayloadSize) {
                maxPayloadInput.value = data.maxPayloadSize;
            }
        })
        .catch(err => console.error('Failed to load config:', err));

    // Save Config Logic
    saveConfigBtn.addEventListener('click', async () => {
        if (!adminPassword) {
            const input = prompt("Please enter the admin password to save settings:");
            if (input) adminPassword = input.trim();
            else return;
        }

        const newLimit = parseInt(maxPayloadInput.value, 10);
        if (!newLimit || newLimit <= 0) {
            alert("Please enter a valid positive number.");
            return;
        }

        try {
            const response = await fetch(`${API_BASE_URL}/config/limits`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${adminPassword}`
                },
                body: JSON.stringify({ maxPayloadSize: newLimit })
            });

            if (response.status === 401) {
                adminPassword = null;
                alert("Unauthorized! Incorrect password.");
                return;
            }

            if (!response.ok) throw new Error('Failed to save');

            const result = await response.json();
            if (result.success) {
                alert(`Limit updated to ${result.maxPayloadSize} bytes.`);
            }
        } catch (error) {
            alert("Error saving config: " + error.message);
        }
    });

    // Close modal logic
    closeButton.onclick = () => modal.style.display = "none";
    window.onclick = (event) => {
        if (event.target == modal) modal.style.display = "none";
    }

    // Refresh button logic
    refreshButton.addEventListener('click', () => {
        refreshButton.disabled = true;
        refreshButton.textContent = 'Refreshing...';
        fetchRequests().finally(() => {
            refreshButton.disabled = false;
            refreshButton.textContent = 'Refresh';
        });
    });

    async function fetchRequests() {
        if (!adminPassword) {
            const input = prompt("Please enter the admin password:");
            if (input) {
                adminPassword = input.trim(); // Trim whitespace/newlines
            } else {
                requestsBody.innerHTML = `<tr><td colspan="7">Password is required to view requests.</td></tr>`;
                return;
            }
        }

        try {
            const response = await fetch(`${API_BASE_URL}/requests`, {
                headers: {
                    'Authorization': `Bearer ${adminPassword}`
                }
            });

            if (response.status === 401) {
                adminPassword = null; // Clear password on failure so user can retry
                throw new Error('Unauthorized! Incorrect password.');
            }
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            const requests = await response.json();
            allRequests = requests;
            renderRequests(requests);
            fetchWalletBalances(); // load balances once we have a valid password
            fetchAlerts();
        } catch (error) {
            requestsBody.innerHTML = `<tr><td colspan="7">Error loading requests: ${error.message}</td></tr>`;
        }
    }

    // Request messages and customer notes are attacker-controlled text. They were
    // previously interpolated into innerHTML raw, which is a stored XSS in this panel.
    //
    // Quotes MUST be escaped: the assignment-to-textContent trick escapes only & < >,
    // which is not sufficient here because these values are also interpolated into
    // attribute values such as title="...". A bare " would close the attribute and let
    // an event handler be injected.
    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
    }

    function truncate(value, max) {
        const s = String(value ?? '');
        return s.length > max ? `${s.slice(0, max)}…` : s;
    }

    // Mirrors backend/src/payload.js describe(). An image order stores base64 in
    // `message`, so truncating it to 80 characters fills the table with gibberish and
    // hides which orders are images — exactly the column an operator scans to moderate.
    const IMAGE_KINDS = { 'image/webp': 'WebP', 'image/jpeg': 'JPEG' };
    function isImagePayload(kind) {
        return Object.prototype.hasOwnProperty.call(IMAGE_KINDS, kind);
    }
    function describePayload(message, kind) {
        if (!isImagePayload(kind)) return message;
        // 4 base64 chars per 3 bytes, minus padding. Good enough for a table cell.
        const s = String(message ?? '');
        const pad = (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
        const bytes = Math.max(0, (s.length / 4) * 3 - pad);
        return `[${IMAGE_KINDS[kind]} image, ${Math.round(bytes)} bytes]`;
    }

    // Exactly the charset a base64 payload may contain. The server validates this before
    // the row is written, but the check is repeated here because this string is about to
    // be concatenated into a URL: anything outside this set means the value is not what we
    // think it is, and the right answer is to render nothing rather than to guess.
    const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

    /**
     * An image payload, rendered for the operator to actually look at.
     *
     * Built with DOM calls, and the `data:` URL's media type comes from the CLOSED enum
     * above — never from the row. Interpolating a server-supplied type into a data: URL is
     * how `data:text/html` ends up rendering on the admin origin, which is the one origin
     * in this service holding a bearer token.
     *
     * Returns null when anything does not line up, and every caller falls back to the text
     * description. Refusing to render is always a safe answer here.
     */
    function imageElement(message, kind) {
        if (!isImagePayload(kind)) return null;
        const b64 = String(message ?? '');
        if (!BASE64_ONLY.test(b64)) return null;
        const img = document.createElement('img');
        img.className = 'payload-image';
        img.alt = 'Customer image payload';
        img.loading = 'lazy';
        img.src = `data:${kind};base64,${b64}`;
        return img;
    }

    function renderRequests(requests) {
        if (!requests || requests.length === 0) {
            requestsBody.innerHTML = '<tr><td colspan="7">No requests found in the database.</td></tr>';
            return;
        }

        requestsBody.innerHTML = requests.map(req => {
            const settled = req.opReturnTxId || req.refundTxId;
            const inFlight = req.status === 'refund_processing' || req.status === 'processing_op_return';
            const canFulfill = !settled && !inFlight &&
                (req.status === 'payment_confirmed' || req.status === 'op_return_failed');
            // Refundable whenever money actually arrived and nothing has been delivered.
            // This deliberately includes underpaid requests still sitting in
            // pending_payment: they hold real funds but never reach a failed state, so
            // without this they would have no refund path at all.
            const holdsFunds = !!(req.paymentTxId || req.paymentReceivedSatoshis);
            const canRefund = !settled && !inFlight && holdsFunds;
            const underpaid = holdsFunds && req.paymentReceivedSatoshis
                && req.paymentReceivedSatoshis < req.requiredAmountSatoshis;

            const note = req.userFeedback
                ? `<span class="customer-note" title="${escapeHtml(req.userFeedback)}">${escapeHtml(truncate(req.userFeedback, 60))}</span>`
                : '<span class="muted">—</span>';

            // Wall moderation. Only meaningful once the customer opted in AND the message
            // actually reached the chain — before that there is nothing on the wall to
            // moderate, and the server refuses the flip anyway.
            const onWall = !!req.isPublic && req.status === 'op_return_broadcasted';
            const hidden = !!req.hiddenByAdmin;

            return `
            <tr${req.userFeedback ? ' class="has-note"' : ''}>
                <td>${escapeHtml(req.id.substring(0, 8))}...</td>
                <td>${escapeHtml(new Date(req.createdAt).toLocaleString())}</td>
                <td>${escapeHtml(truncate(describePayload(req.message, req.payloadKind), 80))}${isImagePayload(req.payloadKind) ? ' <span class="payload-tag">IMG</span>' : ''}</td>
                <td>
                    <span class="status status-${escapeHtml(req.status)}">${escapeHtml(req.status.replace(/_/g, ' '))}</span>
                    ${underpaid ? `<span class="underpaid-flag" title="Received ${escapeHtml(req.paymentReceivedSatoshis)} of ${escapeHtml(req.requiredAmountSatoshis)} sats">UNDERPAID</span>` : ''}
                    ${onWall ? `<span class="wall-flag${hidden ? ' hidden' : ''}" title="${hidden ? 'Hidden from the public wall' : (req.publicSource === 'operator' ? 'On the public wall — put there by you, not opted into by the customer' : 'On the public wall — the customer opted in')}">${hidden ? 'HIDDEN' : (req.publicSource === 'operator' ? 'ON WALL*' : 'ON WALL')}</span>` : ''}
                </td>
                <td>${note}</td>
                <td>${req.opReturnTxId ? `<a href="https://mempool.space/tx/${encodeURIComponent(req.opReturnTxId)}" target="_blank">${escapeHtml(req.opReturnTxId.substring(0, 10))}...</a>` : 'N/A'}</td>
                <td>
                    <button class="button-details" data-id="${escapeHtml(req.id)}" style="background-color: #5bc0de; margin-right: 5px;">Details</button>
                    ${canFulfill ? `<button class="button-fulfill" data-id="${escapeHtml(req.id)}">Manually Fulfill</button>` : ''}
                    ${canRefund ? `<button class="button-refund" data-id="${escapeHtml(req.id)}" style="background-color: #f0ad4e; margin-left: 5px;">Refund</button>` : ''}
                    ${onWall ? `<button class="button-wall" data-id="${escapeHtml(req.id)}" data-hidden="${hidden ? '1' : '0'}" style="background-color: #6f42c1; margin-left: 5px;">${hidden ? 'Show on wall' : 'Hide from wall'}</button>` : ''}
                    <button class="button-delete" data-id="${escapeHtml(req.id)}" style="background-color: #d9534f; margin-left: 5px;">Delete</button>
                </td>
            </tr>
        `;
        }).join('');
    }

    async function showDetails(requestId) {
        const req = allRequests.find(r => r.id === requestId);
        if (!req) return;

        modal.style.display = "block";
        modalBody.innerHTML = '<p>Loading transaction history...</p>';

        try {
            const response = await fetch(`${API_BASE_URL}/address-transactions/${req.address}`, {
                headers: { 'Authorization': `Bearer ${adminPassword}` }
            });
            
            let txHistoryHtml = '';
            if (response.ok) {
                const data = await response.json();
                if (data.txs && data.txs.length > 0) {
                    txHistoryHtml = `<ul class="tx-list">
                        ${data.txs.map(tx => `
                            <li class="tx-item">
                                <strong>TXID:</strong> <a href="https://mempool.space/tx/${encodeURIComponent(tx.hash)}" target="_blank">${escapeHtml(String(tx.hash).substring(0, 20))}...</a><br>
                                <strong>Amount:</strong> ${escapeHtml(tx.total)} sats<br>
                                <strong>Confirmations:</strong> ${escapeHtml(tx.confirmations)}<br>
                                <strong>Time:</strong> ${tx.confirmed ? escapeHtml(new Date(tx.confirmed).toLocaleString()) : 'Unconfirmed'}
                            </li>
                        `).join('')}
                    </ul>`;
                } else {
                    txHistoryHtml = '<p>No transactions found for this address.</p>';
                }
            } else {
                txHistoryHtml = `<p style="color: red;">Error fetching transactions: ${response.statusText}</p>`;
            }

            const feedbackSection = req.userFeedback ? `
                <div class="detail-section customer-note-section">
                    <h3>Customer note</h3>
                    <p style="white-space: pre-wrap;">${escapeHtml(req.userFeedback)}</p>
                    <p class="muted"><small>Left at ${escapeHtml(req.userFeedbackAt ? new Date(req.userFeedbackAt).toLocaleString() : 'unknown time')}</small></p>
                </div>` : '';

            const failureSection = (req.failureReason || req.attemptCount) ? `
                <div class="detail-section">
                    <h3>Failure diagnostics</h3>
                    <p><strong>Reason:</strong> ${escapeHtml(req.failureReason || 'n/a')}</p>
                    <p><strong>Attempts:</strong> ${escapeHtml(req.attemptCount ?? 0)}</p>
                    <p><strong>Last attempt:</strong> ${escapeHtml(req.lastAttemptAt ? new Date(req.lastAttemptAt).toLocaleString() : 'n/a')}</p>
                </div>` : '';

            const refundSection = (req.refundAddress || req.refundTxId) ? `
                <div class="detail-section">
                    <h3>Refund</h3>
                    <p><strong>Refund to:</strong> ${escapeHtml(req.refundAddress || 'unknown')}</p>
                    <p><strong>Refund TX:</strong> ${req.refundTxId
                        ? `<a href="https://mempool.space/tx/${encodeURIComponent(req.refundTxId)}" target="_blank">${escapeHtml(req.refundTxId)}</a>`
                        : 'not refunded'}</p>
                    <p><strong>Refunded at:</strong> ${escapeHtml(req.refundedAt ? new Date(req.refundedAt).toLocaleString() : 'n/a')}</p>
                </div>` : '';

            modalBody.innerHTML = `
                <div class="detail-section">
                    <h3>General Info</h3>
                    <p><strong>ID:</strong> ${escapeHtml(req.id)}</p>
                    <p><strong>Status:</strong> ${escapeHtml(req.status)}</p>
                    <p><strong>Created At:</strong> ${escapeHtml(new Date(req.createdAt).toLocaleString())}</p>
                    <p><strong>Message:</strong> <span style="white-space: pre-wrap;">${escapeHtml(describePayload(req.message, req.payloadKind))}</span></p>
                    ${isImagePayload(req.payloadKind) ? '<p id="detail-payload-image"></p>' : ''}
                </div>
                ${feedbackSection}
                <div class="detail-section">
                    <h3>Payment Info</h3>
                    <p><strong>Address:</strong> ${escapeHtml(req.address)}</p>
                    <p><strong>Required Amount:</strong> ${escapeHtml(req.requiredAmountSatoshis)} sats</p>
                    <p><strong>Received:</strong> ${escapeHtml(req.paymentReceivedSatoshis ?? 'not recorded')} sats</p>
                    <p><strong>Confirmed at:</strong> ${escapeHtml(req.paymentConfirmedAt ? new Date(req.paymentConfirmedAt).toLocaleString() : 'n/a')}</p>
                    <p><strong>Recipient:</strong> ${escapeHtml(req.targetAddress || 'none')} ${req.targetAddress ? `(${escapeHtml(req.amountToSend ?? 0)} sats)` : ''}</p>
                </div>
                ${failureSection}
                ${refundSection}
                <div class="detail-section">
                    <h3>Transaction History (from Blockchain)</h3>
                    ${txHistoryHtml}
                </div>
            `;

            // Appended after the innerHTML assignment, not interpolated into it: the src
            // is built by imageElement from a validated base64 string, and keeping it out
            // of the template string means the payload never passes through HTML parsing
            // at all. Absent or malformed, the description above already stands alone.
            const imageSlot = modalBody.querySelector('#detail-payload-image');
            if (imageSlot) {
                const img = imageElement(req.message, req.payloadKind);
                if (img) imageSlot.appendChild(img);
                else imageSlot.textContent = 'This image payload could not be decoded for display.';
            }

        } catch (error) {
            modalBody.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
        }
    }

    // --- Warnings panel ---------------------------------------------------
    // Alerts come from the database, so they persist across restarts. The event log is
    // an in-memory tail of what the server has been warning about since it started.
    async function fetchAlerts() {
        if (!adminPassword) return;

        refreshAlertsBtn.disabled = true;
        refreshAlertsBtn.textContent = 'Loading...';
        try {
            const res = await fetch(`${API_BASE_URL}/alerts`, {
                headers: { 'Authorization': `Bearer ${adminPassword}` }
            });
            if (!res.ok) {
                alertsBody.innerHTML = `<p class="muted">Could not load warnings (HTTP ${res.status}).</p>`;
                return;
            }
            const data = await res.json();
            renderAlerts(data);
        } catch (e) {
            alertsBody.innerHTML = `<p class="muted">Could not load warnings: ${escapeHtml(e.message)}</p>`;
        } finally {
            refreshAlertsBtn.disabled = false;
            refreshAlertsBtn.textContent = 'Refresh';
        }
    }

    function renderAlerts(data) {
        const { counts, alerts, events } = data;

        // Badge summarising severity at a glance.
        if (counts.critical > 0) {
            alertsBadge.className = 'alerts-badge badge-critical';
            alertsBadge.textContent = `${counts.critical} need attention`;
        } else if (counts.warning > 0) {
            alertsBadge.className = 'alerts-badge badge-warning';
            alertsBadge.textContent = `${counts.warning} warning${counts.warning > 1 ? 's' : ''}`;
        } else {
            alertsBadge.className = 'alerts-badge badge-ok';
            alertsBadge.textContent = 'all clear';
        }

        if (!alerts.length) {
            alertsBody.innerHTML = '<p class="all-clear">No orders are holding customer funds. Nothing needs attention.</p>';
        } else {
            alertsBody.innerHTML = alerts.map(a => `
                <div class="alert alert-${escapeHtml(a.severity)}">
                    <div class="alert-title">
                        ${escapeHtml(a.title)}
                        <span class="alert-request">${escapeHtml(String(a.requestId).substring(0, 8))}</span>
                    </div>
                    <div class="alert-detail">${escapeHtml(a.detail)}</div>
                    <div class="alert-meta">
                        ${a.since ? `since ${escapeHtml(new Date(a.since).toLocaleString())}` : ''}
                        ${a.address ? ` &middot; <a href="https://mempool.space/address/${encodeURIComponent(a.address)}" target="_blank">view address</a>` : ''}
                    </div>
                </div>
            `).join('');
        }

        if (!events || !events.length) {
            eventLogBody.innerHTML = '<p class="muted">Nothing logged since the server started.</p>';
        } else {
            eventLogBody.innerHTML = `<div class="event-log">${events.map(e => `
                <div class="event event-${escapeHtml(e.level)}">
                    <span class="event-time">${escapeHtml(new Date(e.at).toLocaleTimeString())}</span>
                    <span class="event-msg">${escapeHtml(e.message)}</span>
                </div>
            `).join('')}</div>`;
        }
    }

    refreshAlertsBtn.addEventListener('click', fetchAlerts);

    requestsBody.addEventListener('click', async (event) => {
        const detailsButton = event.target.closest('.button-details');
        const fulfillButton = event.target.closest('.button-fulfill');
        const refundButton = event.target.closest('.button-refund');
        const deleteButton = event.target.closest('.button-delete');
        const wallButton = event.target.closest('.button-wall');

        if (wallButton) {
            const requestId = wallButton.dataset.id;
            const hide = wallButton.dataset.hidden !== '1';
            const question = hide
                ? `Hide this message from the public wall?\n\nIt stays on the Bitcoin blockchain either way — this only controls whether satwire.io repeats it.`
                : `Put this message back on the public wall?`;
            if (confirm(question)) {
                wallButton.disabled = true;
                wallButton.textContent = hide ? 'Hiding...' : 'Showing...';
                try {
                    const response = await fetch(`${API_BASE_URL}/requests/${encodeURIComponent(requestId)}/visibility`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${adminPassword}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ hidden: hide }),
                    });
                    const result = await response.json();
                    if (response.ok && result.success) {
                        fetchRequests();
                    } else {
                        throw new Error(result.error || 'Could not change visibility.');
                    }
                } catch (error) {
                    alert(`Error: ${error.message}`);
                    wallButton.disabled = false;
                    wallButton.textContent = hide ? 'Hide from wall' : 'Show on wall';
                }
            }
        }

        if (detailsButton) {
            showDetails(detailsButton.dataset.id);
        }

        if (refundButton) {
            const requestId = refundButton.dataset.id;
            if (confirm(`Refund the payer for request ${requestId}? This sends a real Bitcoin transaction and cannot be undone.`)) {
                refundButton.disabled = true;
                refundButton.textContent = 'Refunding...';
                try {
                    const response = await fetch(`${API_BASE_URL}/refund/${encodeURIComponent(requestId)}`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${adminPassword}` }
                    });
                    const result = await response.json();
                    if (response.ok && result.success) {
                        alert(`Refunded ${result.amount} sats. TXID: ${result.refundTxId}`);
                        fetchRequests();
                    } else {
                        throw new Error(result.error || 'Refund failed.');
                    }
                } catch (error) {
                    alert(`Error: ${error.message}`);
                    refundButton.disabled = false;
                    refundButton.textContent = 'Refund';
                }
            }
        }

        if (fulfillButton) {
            const button = fulfillButton;
            const requestId = button.dataset.id;
            
            if (confirm(`Are you sure you want to manually fulfill request ${requestId}?`)) {
                button.disabled = true;
                button.textContent = 'Fulfilling...';

                // The server refuses an archived request — one the customer cancelled, or
                // one abandoned unpaid — unless the operator says so a second time.
                // Publishing it puts a withdrawn message on-chain permanently, so the
                // second confirmation names exactly that.
                const send = (confirmArchived) => fetch(`${API_BASE_URL}/fulfill/${encodeURIComponent(requestId)}`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${adminPassword}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(confirmArchived ? { confirmArchived: true } : {}),
                });

                try {
                    let response = await send(false);
                    let result = await response.json();

                    if (response.status === 409 && result.needsConfirmation === 'confirmArchived') {
                        if (!confirm(`${result.error}\n\nPublish it anyway? This cannot be undone.`)) {
                            button.disabled = false;
                            button.textContent = 'Manually Fulfill';
                            return;
                        }
                        response = await send(true);
                        result = await response.json();
                    }

                    if (response.ok && result.success) {
                        alert(`Successfully fulfilled request! TXID: ${result.txId}`);
                        fetchRequests(); // Refresh the list
                    } else {
                        throw new Error(result.error || 'Fulfillment failed.');
                    }
                } catch (error) {
                    alert(`Error: ${error.message}`);
                    button.disabled = false;
                    button.textContent = 'Manually Fulfill';
                }
            }
        }

        if (deleteButton) {
            const button = deleteButton;
            const requestId = button.dataset.id;

            if (confirm(`Are you sure you want to DELETE request ${requestId}? This cannot be undone.`)) {
                button.disabled = true;
                button.textContent = 'Deleting...';
                try {
                    const response = await fetch(`${API_BASE_URL}/requests/${encodeURIComponent(requestId)}`, {
                        method: 'DELETE',
                        headers: {
                            'Authorization': `Bearer ${adminPassword}`
                        }
                    });
                    
                    if (response.ok) {
                        // alert('Request deleted successfully.');
                        fetchRequests(); // Refresh the list
                    } else {
                        const result = await response.json();
                        throw new Error(result.error || 'Delete failed.');
                    }
                } catch (error) {
                    console.error(error);
                    alert(`Error: ${error.message}`);
                    button.disabled = false;
                    button.textContent = 'Delete';
                }
            }
        }
    });

    fetchRequests();

    // --- Wallet -----------------------------------------------------------
    // Shows every branch of the seed, not just the two addresses the old panel had
    // hard-coded, and can look up any derivation path on demand.

    const WALLET_API = `${API_BASE_URL}/wallet`;
    const walletNotice = document.getElementById('wallet-notice');
    const walletBranches = document.getElementById('wallet-branches');

    // Links point at blockstream.info rather than mempool.space: mempool.space is not
    // reachable from this network at all (the connection times out), so those links
    // would simply hang.
    const explorerAddress = (addr) => `https://blockstream.info/address/${encodeURIComponent(addr)}`;

    const fmtSats = (sats) => `${Number(sats || 0).toLocaleString('en-US')} sats`;

    function fmtFiat(sats, price) {
        if (!price || !price.eur || !sats) return '';
        const eur = (sats / 1e8) * price.eur;
        const shown = eur < 0.01 ? eur.toFixed(4) : eur.toFixed(2);
        return `about €${shown}`;
    }

    function fmtAge(iso) {
        if (!iso) return '';
        const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (seconds < 90) return `${seconds} seconds ago`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 90) return `${minutes} minutes ago`;
        const hours = Math.round(minutes / 60);
        if (hours < 36) return `${hours} hours ago`;
        return `${Math.round(hours / 24)} days ago`;
    }

    function setSplit(id, sats, extraClass) {
        const el = document.getElementById(id);
        el.textContent = fmtSats(sats);
        el.className = `wallet-split-value${sats === 0 ? ' is-zero' : (extraClass ? ` ${extraClass}` : '')}`;
    }

    async function fetchWallet(refresh) {
        // Say so rather than sitting on "Loading…" forever, which is what happens when
        // the password prompt is dismissed.
        if (!adminPassword) {
            walletBranches.innerHTML = '<p class="muted">Enter the admin password to see the wallet.</p>';
            return;
        }

        refreshBalancesBtn.disabled = true;
        refreshBalancesBtn.textContent = refresh ? 'Checking…' : 'Loading…';

        try {
            const res = await fetch(`${WALLET_API}/overview${refresh ? '?refresh=1' : ''}`, {
                headers: { 'Authorization': `Bearer ${adminPassword}` }
            });
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                walletBranches.innerHTML = `<p class="muted">Could not read the wallet: ${escapeHtml(body.error || `HTTP ${res.status}`)}</p>`;
                return;
            }
            renderWallet(await res.json());
        } catch (e) {
            walletBranches.innerHTML = `<p class="muted">Could not read the wallet: ${escapeHtml(e.message)}</p>`;
        } finally {
            refreshBalancesBtn.disabled = false;
            refreshBalancesBtn.textContent = 'Refresh';
        }
    }

    function renderWallet(data) {
        const { totals, branches, price } = data;

        document.getElementById('wallet-total').textContent = fmtSats(totals.total);
        document.getElementById('wallet-total-fiat').textContent = fmtFiat(totals.total, price);
        setSplit('wallet-yours', totals.yours);
        setSplit('wallet-customer', totals.customerFunds, 'is-customer');
        setSplit('wallet-unconfirmed', totals.unconfirmed);
        document.getElementById('wallet-checked').textContent = `Checked ${fmtAge(data.generatedAt)}`;

        // A number that might be wrong must never look authoritative. An incomplete scan
        // or a stale figure is said plainly, above the total.
        const problems = [];
        if (data.incomplete) {
            problems.push('Some addresses could not be checked just now, so the total above may be too low. Try Refresh in a minute.');
        }
        if (data.staleCount > 0) {
            problems.push(`${data.staleCount} address${data.staleCount > 1 ? 'es are' : ' is'} showing an older figure` +
                `${data.oldestStaleAt ? ` (oldest from ${fmtAge(data.oldestStaleAt)})` : ''}, because the block explorer did not answer.`);
        }
        if (problems.length) {
            walletNotice.style.display = '';
            walletNotice.innerHTML = problems.map((p) => `<div>${escapeHtml(p)}</div>`).join('');
        } else {
            walletNotice.style.display = 'none';
            walletNotice.innerHTML = '';
        }

        walletBranches.innerHTML = branches.map(renderBranch).join('')
            || '<p class="muted">No branches configured.</p>';
    }

    // `options.isScanResult` marks a one-off lookup that is not on the watchlist, so it
    // gets no "Stop watching" button — there would be no entry for it to remove.
    function renderBranch(branch, options) {
        const isScanResult = !!(options && options.isScanResult);
        const typeLabel = {
            p2wpkh: 'Native SegWit', p2tr: 'Taproot', p2sh_p2wpkh: 'Nested SegWit', p2pkh: 'Legacy',
        }[branch.type] || branch.type;

        const pathLabel = branch.mode === 'single' ? branch.path : `${branch.path}/…`;
        const receive = branch.receiveAddress;

        const receiveBlock = receive && receive.address ? `
            <div class="branch-receive">
                <span>Send funds here:</span>
                <span class="receive-addr">${escapeHtml(receive.address)}</span>
                <button class="btn-tiny btn-qr" data-address="${escapeHtml(receive.address)}"
                        data-label="${escapeHtml(branch.label)}"
                        data-fixed="${branch.receiveIsFixed ? '1' : ''}">Show QR code</button>
            </div>` : '';

        const rows = branch.addresses.map((a) => {
            if (a.error) {
                return `<tr class="addr-error"><td colspan="5">${escapeHtml(a.path)} — ${escapeHtml(a.error)}</td></tr>`;
            }
            const balance = (a.confirmed || 0) + (a.unconfirmed || 0);
            const pending = a.request && !a.request.settled
                ? `<span class="addr-flag flag-pending" title="Order ${escapeHtml(a.request.requestId)} (${escapeHtml(a.request.status)}) has not been delivered or refunded">not delivered</span>`
                : '';
            const stale = a.stale && a.cachedAt
                ? `<span class="addr-flag flag-stale" title="Figure from ${escapeHtml(fmtAge(new Date(a.cachedAt).toISOString()))}">old</span>`
                : '';
            // The row's own QR must carry the same warning the branch header does. On the
            // treasury this address IS the one the service spends from, and the row
            // button would otherwise open a code with no such note.
            const rowIsFixed = branch.receiveIsFixed && receive && receive.address === a.address;
            return `
                <tr>
                    <td class="addr-num">${a.index === null ? '—' : escapeHtml(a.index)}</td>
                    <td class="addr-mono"><a href="${explorerAddress(a.address)}" target="_blank" rel="noopener">${escapeHtml(a.address)}</a>${pending}${stale}</td>
                    <td class="addr-num ${balance > 0 ? 'has-balance' : ''}">${escapeHtml(Number(balance).toLocaleString('en-US'))}</td>
                    <td class="addr-num">${escapeHtml(a.txCount ?? 0)}</td>
                    <td class="addr-num"><button class="btn-tiny btn-qr" data-address="${escapeHtml(a.address)}" data-label="${escapeHtml(branch.label)}" data-fixed="${rowIsFixed ? '1' : ''}">QR</button></td>
                </tr>`;
        }).join('');

        const table = branch.addresses.length ? `
            <table class="addr-table">
                <thead><tr><th>#</th><th>Address</th><th>Balance (sats)</th><th>Txs</th><th></th></tr></thead>
                <tbody>${rows}</tbody>
            </table>` : '<p class="muted">This path has never been used.</p>';

        const warn = branch.incomplete
            ? `<p class="branch-warn">${escapeHtml(branch.incompleteReason || 'This branch could not be read completely.')}</p>`
            : '';

        const removeBtn = (branch.builtIn || isScanResult) ? '' :
            `<button class="btn-tiny btn-unwatch" data-id="${escapeHtml(branch.id)}">Stop watching</button>`;

        return `
        <details class="branch"${branch.total > 0 ? ' open' : ''}>
            <summary>
                <span class="branch-name">${escapeHtml(branch.label)}</span>
                <span class="branch-balance${branch.total === 0 ? ' is-zero' : ''}">${escapeHtml(fmtSats(branch.total))}</span>
                <span class="branch-meta">${escapeHtml(pathLabel)} &middot; ${escapeHtml(typeLabel)} &middot; ${escapeHtml(branch.usedCount)} used, ${escapeHtml(branch.fundedCount)} holding money</span>
            </summary>
            <div class="branch-body">
                ${branch.note ? `<p class="branch-note">${escapeHtml(branch.note)}</p>` : ''}
                ${warn}
                ${receiveBlock}
                ${table}
                ${removeBtn ? `<div style="margin-top:0.8rem;">${removeBtn}</div>` : ''}
            </div>
        </details>`;
    }

    // --- Path scanner -----------------------------------------------------

    const scanPathInput = document.getElementById('scan-path');
    const scanTypeSelect = document.getElementById('scan-type');
    const scanModeSelect = document.getElementById('scan-mode');
    const scanBtn = document.getElementById('scan-btn');
    const scanResult = document.getElementById('scan-result');
    const watchlistBody = document.getElementById('watchlist-body');

    scanBtn.addEventListener('click', async () => {
        if (!adminPassword) return;
        const path = scanPathInput.value.trim();
        if (!path) {
            scanResult.innerHTML = '<div class="scan-message is-error">Enter a derivation path first.</div>';
            return;
        }

        scanBtn.disabled = true;
        scanBtn.textContent = 'Looking…';
        scanResult.innerHTML = '<p class="muted">Checking the blockchain, this can take a moment…</p>';

        try {
            const res = await fetch(`${WALLET_API}/scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminPassword}` },
                body: JSON.stringify({ path, type: scanTypeSelect.value, mode: scanModeSelect.value })
            });
            const data = await res.json();
            if (!res.ok) {
                scanResult.innerHTML = `<div class="scan-message is-error">${escapeHtml(data.error || `HTTP ${res.status}`)}</div>`;
                return;
            }
            renderScanResult(data);
        } catch (e) {
            scanResult.innerHTML = `<div class="scan-message is-error">${escapeHtml(e.message)}</div>`;
        } finally {
            scanBtn.disabled = false;
            scanBtn.textContent = 'Look up';
        }
    });

    function renderScanResult(data) {
        let message;
        if (data.anyFunds) {
            message = `<div class="scan-message is-found">Found ${escapeHtml(fmtSats(data.total))} on <code>${escapeHtml(data.path)}</code>.</div>`;
        } else if (data.anyHistory) {
            message = `<div class="scan-message is-empty">This path has been used before but holds nothing now.</div>`;
        } else {
            message = `<div class="scan-message is-empty">Nothing found on <code>${escapeHtml(data.path)}</code>. If you expected money here, try a different address type.</div>`;
        }

        const canWatch = data.requestedType !== 'all';
        const watchBtn = canWatch
            ? `<button class="btn btn-primary btn-watch" data-path="${escapeHtml(data.path)}" data-type="${escapeHtml(data.requestedType)}" data-mode="${escapeHtml(data.mode)}">Keep this in my totals</button>`
            : '<p class="muted">Pick a single address type to keep a path in your totals.</p>';

        scanResult.innerHTML = message + data.results.map((b) => renderBranch(b, { isScanResult: true })).join('')
            + `<div style="margin-top:0.8rem;">${watchBtn}</div>`;
    }

    async function fetchWatchlist() {
        if (!adminPassword) return;
        try {
            const res = await fetch(`${WALLET_API}/watchlist`, { headers: { 'Authorization': `Bearer ${adminPassword}` } });
            if (!res.ok) return;
            renderWatchlist((await res.json()).watchlist);
        } catch (e) {
            console.error('Failed to load the watchlist:', e);
        }
    }

    function renderWatchlist(list) {
        if (!list || !list.length) {
            watchlistBody.innerHTML = '<p class="muted">None yet. Anything you keep here is counted in the total above from then on.</p>';
            return;
        }
        watchlistBody.innerHTML = list.map((w) => `
            <div class="watch-row">
                <span><strong>${escapeHtml(w.label)}</strong> <span class="watch-path">${escapeHtml(w.path)}${w.mode === 'single' ? '' : '/…'}</span></span>
                <button class="btn-tiny btn-unwatch" data-id="${escapeHtml(w.id)}">Remove</button>
            </div>`).join('');
    }

    async function addToWatchlist(path, type, mode) {
        const res = await fetch(`${WALLET_API}/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${adminPassword}` },
            body: JSON.stringify({ path, type, mode })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    async function removeFromWatchlist(id) {
        const res = await fetch(`${WALLET_API}/watchlist/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${adminPassword}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    }

    // --- Receive / QR modal ----------------------------------------------

    const qrModal = document.getElementById('qr-modal');
    const qrHolder = document.getElementById('qr-holder');
    const qrAddressEl = document.getElementById('qr-address');
    const qrTitle = document.getElementById('qr-title');
    const qrSubtitle = document.getElementById('qr-subtitle');
    const qrAmountInput = document.getElementById('qr-amount');
    let qrCurrentAddress = null;
    let qrObjectUrl = null;
    // Every draw gets a ticket. A response whose ticket is no longer the current one is
    // discarded instead of rendered. Without this, opening one address's code and then
    // another's can leave the slower first response painted next to the second address's
    // text — a QR that does not match the address shown under it, which is the one way
    // this panel could send money to the wrong place.
    let qrRequestToken = 0;

    function releaseQrUrl() {
        if (qrObjectUrl) { URL.revokeObjectURL(qrObjectUrl); qrObjectUrl = null; }
    }

    async function drawQr(address, amountSats) {
        // The QR is fetched rather than linked because the endpoint needs the admin
        // bearer token, which an <img src> cannot send. The SVG becomes a blob URL, so
        // nothing server-generated is ever pushed through innerHTML.
        const token = ++qrRequestToken;
        releaseQrUrl();
        qrHolder.innerHTML = '<p style="color:#000;font-size:0.8rem;">Drawing…</p>';

        const params = new URLSearchParams({ address, label: 'SatWire' });
        if (amountSats > 0) params.set('amount', String(amountSats));

        try {
            const res = await fetch(`${WALLET_API}/qr.svg?${params.toString()}`, {
                headers: { 'Authorization': `Bearer ${adminPassword}` }
            });
            if (token !== qrRequestToken) return; // superseded
            if (!res.ok) {
                const body = await res.json().catch(() => ({}));
                qrHolder.innerHTML = `<p style="color:#a00;font-size:0.8rem;">${escapeHtml(body.error || `HTTP ${res.status}`)}</p>`;
                return;
            }
            const blob = await res.blob();
            // Re-checked after the second await: the modal may have been closed or
            // redrawn while the body was still arriving, and the URL created below would
            // then never be revoked.
            if (token !== qrRequestToken) return;
            const url = URL.createObjectURL(blob);
            qrObjectUrl = url;
            const img = document.createElement('img');
            img.src = url;
            img.alt = 'Payment QR code';
            qrHolder.innerHTML = '';
            qrHolder.appendChild(img);
        } catch (e) {
            if (token !== qrRequestToken) return;
            qrHolder.innerHTML = `<p style="color:#a00;font-size:0.8rem;">${escapeHtml(e.message)}</p>`;
        }
    }

    function openQr(address, label, isFixed) {
        qrCurrentAddress = address;
        qrTitle.textContent = label ? `Send funds to: ${label}` : 'Send funds here';
        qrSubtitle.textContent = isFixed
            ? 'This is the exact address the service spends from. Do not use a different one.'
            : 'Scan this with your phone wallet.';
        qrAddressEl.textContent = address;
        qrAmountInput.value = '';
        qrModal.style.display = 'block';
        drawQr(address, 0);
    }

    function closeQr() {
        qrModal.style.display = 'none';
        qrRequestToken++; // any draw still in flight is now stale and must not paint
        releaseQrUrl();
        qrHolder.innerHTML = '';
        qrCurrentAddress = null;
    }

    document.querySelector('.qr-close-button').addEventListener('click', closeQr);
    // addEventListener rather than window.onclick, which is already assigned above for
    // the request detail modal and would be overwritten.
    window.addEventListener('click', (event) => { if (event.target === qrModal) closeQr(); });
    document.getElementById('qr-amount-apply').addEventListener('click', () => {
        if (qrCurrentAddress) drawQr(qrCurrentAddress, parseInt(qrAmountInput.value, 10) || 0);
    });
    document.getElementById('qr-copy').addEventListener('click', async () => {
        if (!qrCurrentAddress) return;
        const btn = document.getElementById('qr-copy');
        try {
            await navigator.clipboard.writeText(qrCurrentAddress);
            btn.textContent = 'Copied';
        } catch (e) {
            btn.textContent = 'Copy failed';
        }
        setTimeout(() => { btn.textContent = 'Copy address'; }, 1500);
    });

    // One delegated handler for every button the wallet renders, so re-rendering never
    // leaves listeners behind.
    document.getElementById('wallet-container').addEventListener('click', async (event) => {
        const qrButton = event.target.closest('.btn-qr');
        if (qrButton) {
            event.preventDefault();
            openQr(qrButton.dataset.address, qrButton.dataset.label, qrButton.dataset.fixed === '1');
            return;
        }

        const watchButton = event.target.closest('.btn-watch');
        if (watchButton) {
            watchButton.disabled = true;
            try {
                await addToWatchlist(watchButton.dataset.path, watchButton.dataset.type, watchButton.dataset.mode);
                watchButton.textContent = 'Added';
                await fetchWatchlist();
                await fetchWallet(false);
            } catch (e) {
                alert(`Could not save: ${e.message}`);
                watchButton.disabled = false;
            }
            return;
        }

        const unwatchButton = event.target.closest('.btn-unwatch');
        if (unwatchButton) {
            unwatchButton.disabled = true;
            try {
                await removeFromWatchlist(unwatchButton.dataset.id);
                await fetchWatchlist();
                await fetchWallet(false);
            } catch (e) {
                alert(`Could not remove: ${e.message}`);
                unwatchButton.disabled = false;
            }
        }
    });

    // Refresh forces fresh blockchain lookups; the first load may use cached figures.
    refreshBalancesBtn.addEventListener('click', () => fetchWallet(true));

    function fetchWalletBalances() {
        fetchWallet(false);
        fetchWatchlist();
    }
});