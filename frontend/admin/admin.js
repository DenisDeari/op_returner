// frontend/admin/admin.js
document.addEventListener('DOMContentLoaded', () => {
    const requestsBody = document.getElementById('requests-body');
    const modal = document.getElementById('detail-modal');
    const modalBody = document.getElementById('modal-body');
    const closeButton = document.querySelector('.close-button');
    const refreshButton = document.getElementById('refresh-button');
    const refreshBalancesBtn = document.getElementById('refresh-balances-btn');

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

    function renderRequests(requests) {
        if (!requests || requests.length === 0) {
            requestsBody.innerHTML = '<tr><td colspan="7">No requests found in the database.</td></tr>';
            return;
        }

        requestsBody.innerHTML = requests.map(req => {
            const canFulfill = !req.opReturnTxId && !req.refundTxId &&
                (req.status === 'payment_confirmed' || req.status === 'op_return_failed');
            const canRefund = !req.opReturnTxId && !req.refundTxId &&
                (req.status === 'op_return_failed' || req.status === 'refund_failed');

            const note = req.userFeedback
                ? `<span class="customer-note" title="${escapeHtml(req.userFeedback)}">${escapeHtml(truncate(req.userFeedback, 60))}</span>`
                : '<span class="muted">—</span>';

            return `
            <tr${req.userFeedback ? ' class="has-note"' : ''}>
                <td>${escapeHtml(req.id.substring(0, 8))}...</td>
                <td>${escapeHtml(new Date(req.createdAt).toLocaleString())}</td>
                <td>${escapeHtml(truncate(req.message, 80))}</td>
                <td><span class="status status-${escapeHtml(req.status)}">${escapeHtml(req.status.replace(/_/g, ' '))}</span></td>
                <td>${note}</td>
                <td>${req.opReturnTxId ? `<a href="https://mempool.space/tx/${encodeURIComponent(req.opReturnTxId)}" target="_blank">${escapeHtml(req.opReturnTxId.substring(0, 10))}...</a>` : 'N/A'}</td>
                <td>
                    <button class="button-details" data-id="${escapeHtml(req.id)}" style="background-color: #5bc0de; margin-right: 5px;">Details</button>
                    ${canFulfill ? `<button class="button-fulfill" data-id="${escapeHtml(req.id)}">Manually Fulfill</button>` : ''}
                    ${canRefund ? `<button class="button-refund" data-id="${escapeHtml(req.id)}" style="background-color: #f0ad4e; margin-left: 5px;">Refund</button>` : ''}
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
                    <p><strong>Message:</strong> <span style="white-space: pre-wrap;">${escapeHtml(req.message)}</span></p>
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

        } catch (error) {
            modalBody.innerHTML = `<p style="color: red;">Error: ${error.message}</p>`;
        }
    }

    requestsBody.addEventListener('click', async (event) => {
        const detailsButton = event.target.closest('.button-details');
        const fulfillButton = event.target.closest('.button-fulfill');
        const refundButton = event.target.closest('.button-refund');
        const deleteButton = event.target.closest('.button-delete');

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
                try {
                    const response = await fetch(`${API_BASE_URL}/fulfill/${encodeURIComponent(requestId)}`, {
                        method: 'POST',
                        headers: {
                           'Authorization': `Bearer ${adminPassword}`
                        }
                    });
                    const result = await response.json();

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

    // --- Wallet Balances ---
    async function fetchWalletBalances() {
        if (!adminPassword) return;

        refreshBalancesBtn.disabled = true;
        refreshBalancesBtn.textContent = 'Loading...';

        try {
            const res = await fetch(`${API_BASE_URL}/wallet-balances`, {
                headers: { 'Authorization': `Bearer ${adminPassword}` }
            });
            if (!res.ok) { refreshBalancesBtn.disabled = false; refreshBalancesBtn.textContent = 'Refresh'; return; }
            const data = await res.json();

            const fmt = (sats) => sats.toLocaleString() + ' sats';
            const mempoolLink = (addr) => `<a href="https://mempool.space/address/${addr}" target="_blank">${addr}</a>`;

            document.getElementById('treasury-address').innerHTML = mempoolLink(data.treasury.address);
            document.getElementById('treasury-confirmed').textContent = fmt(data.treasury.confirmed);
            document.getElementById('treasury-unconfirmed').textContent =
                data.treasury.unconfirmed !== 0 ? `${data.treasury.unconfirmed > 0 ? '+' : ''}${fmt(data.treasury.unconfirmed)} unconfirmed` : '';

            document.getElementById('user-address').innerHTML = mempoolLink(data.userWallet.address);
            document.getElementById('user-confirmed').textContent = fmt(data.userWallet.confirmed);
            document.getElementById('user-unconfirmed').textContent =
                data.userWallet.unconfirmed !== 0 ? `${data.userWallet.unconfirmed > 0 ? '+' : ''}${fmt(data.userWallet.unconfirmed)} unconfirmed` : '';
        } catch (e) {
            console.error('Failed to fetch wallet balances:', e);
        } finally {
            refreshBalancesBtn.disabled = false;
            refreshBalancesBtn.textContent = 'Refresh';
        }
    }

    refreshBalancesBtn.addEventListener('click', fetchWalletBalances);
});