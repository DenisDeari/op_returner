// frontend/js/app.js
document.addEventListener('DOMContentLoaded', () => {
    let MAX_BYTES = 1000;

    // Fetch dynamic limits
    fetch('/api/config/limits')
        .then(res => res.json())
        .then(data => {
            if (data.maxPayloadSize) {
                MAX_BYTES = data.maxPayloadSize;
                updateByteCounter();
            }
        })
        .catch(() => {});

    // State
    let activeOrders = JSON.parse(localStorage.getItem('opr_orders')) || [];

    // DOM
    const messageInput = document.getElementById('message-input');
    const targetAddressInput = document.getElementById('target-address-input');
    const amountInput = document.getElementById('amount-input');
    const feeRateSlider = document.getElementById('fee-rate-slider');
    const feeRateDisplay = document.getElementById('fee-rate-display');
    const costNetworkFee = document.getElementById('cost-network-fee');
    const costRecipientAmount = document.getElementById('cost-recipient-amount');
    const costTotal = document.getElementById('cost-total');
    const byteCounter = document.getElementById('byte-counter');
    const executeButton = document.getElementById('execute-button');
    const activeOrdersList = document.getElementById('active-orders-list');

    // Modal
    const paymentModal = document.getElementById('payment-modal');
    const closePaymentModal = document.getElementById('close-payment-modal');
    const modalRequiredAmount = document.getElementById('modal-required-amount');
    const modalPaymentAddress = document.getElementById('modal-payment-address');
    const modalCopyAddressButton = document.getElementById('modal-copy-address-button');

    // --- Helpers ---
    function saveOrders() {
        localStorage.setItem('opr_orders', JSON.stringify(activeOrders));
    }

    // Escapes quotes as well as angle brackets: these values are interpolated into
    // attribute values (href, title), where a bare quote would break out of the attribute.
    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
    }

    function updateByteCounter() {
        const message = messageInput.value;
        const byteLength = new TextEncoder().encode(message).length;

        if (byteLength > MAX_BYTES) {
            let current = message;
            while (new TextEncoder().encode(current).length > MAX_BYTES) {
                current = current.slice(0, -1);
            }
            messageInput.value = current;
            updateByteCounter();
            return;
        }

        byteCounter.textContent = `${byteLength} / ${MAX_BYTES} bytes`;
        byteCounter.style.color = byteLength >= MAX_BYTES ? '#f85149' : '';
    }

    function updateCostBreakdown() {
        const feeRate = parseInt(feeRateSlider.value);
        const amountToSend = parseInt(amountInput.value) || 0;
        const message = messageInput.value || '';
        const recipient = targetAddressInput.value;

        feeRateDisplay.textContent = feeRate;

        let vBytes = 10.5 + 68;
        const messageBytes = new TextEncoder().encode(message).length;
        vBytes += (11 + messageBytes);
        vBytes += 31;
        if (recipient) vBytes += 31;
        vBytes = Math.ceil(vBytes);

        const networkFee = vBytes * feeRate;
        const serviceFee = 2000;
        const total = networkFee + serviceFee + amountToSend;

        costNetworkFee.textContent = `~${networkFee.toLocaleString()} sats`;
        costRecipientAmount.textContent = `${amountToSend.toLocaleString()} sats`;
        costTotal.textContent = `~${total.toLocaleString()} sats`;
    }

    // --- Orders ---
    function addOrder(data) {
        if (!activeOrders.find(o => o.requestId === data.requestId)) {
            activeOrders.unshift({
                ...data,
                status: 'pending_payment',
                createdAt: new Date().toISOString()
            });
            saveOrders();
            renderOrders();
        }
    }

    function removeOrder(requestId) {
        activeOrders = activeOrders.filter(o => o.requestId !== requestId);
        saveOrders();
        renderOrders();
    }

    // Statuses that mean the request did not succeed. The customer can leave a message
    // for the operator from any of these.
    const FAILURE_STATUSES = ['op_return_failed', 'refund_failed', 'refund_processing', 'refunded'];
    const isFailure = (status) => FAILURE_STATUSES.includes(status);

    // Statuses where nothing further will change, so polling can stop.
    const TERMINAL_STATUSES = ['op_return_broadcasted', 'refunded', 'refund_failed'];

    function updateOrderStatus(requestId, data) {
        const order = activeOrders.find(o => o.requestId === requestId);
        if (!order) return;

        let changed = false;
        const apply = (key, value) => {
            if (value !== undefined && value !== null && order[key] !== value) {
                order[key] = value;
                changed = true;
            }
        };

        apply('status', data.status);
        apply('txId', data.opReturnTxId);
        apply('supportEmail', data.supportEmail);
        apply('refundTxId', data.refundTxId);
        apply('failureReason', data.failureReason);
        // Feedback may have been submitted from another device/session.
        if (data.userFeedback && !order.feedbackSent) {
            order.feedbackSent = true;
            changed = true;
        }

        if (changed) {
            saveOrders();
            renderOrders();
        }
    }

    // In-progress feedback text, kept outside the DOM so a re-render (which happens on
    // every status poll) does not discard what the customer is part-way through typing.
    const feedbackDrafts = {};

    function renderOrders() {
        // Remember which feedback box had focus so it can be restored after the rebuild.
        const active = document.activeElement;
        const focusedFeedbackId = active && active.classList && active.classList.contains('feedback-input')
            ? active.dataset.id
            : null;
        const selectionStart = focusedFeedbackId ? active.selectionStart : null;

        activeOrdersList.innerHTML = '';

        if (activeOrders.length === 0) {
            activeOrdersList.innerHTML = '<p class="placeholder">No active requests.</p>';
            return;
        }

        activeOrders.forEach(order => {
            const failed = isFailure(order.status);
            const el = document.createElement('div');
            el.className = `order-item${failed ? ' failed' : ''}`;

            let statusText = order.status.replace(/_/g, ' ').toUpperCase();
            let statusClass = 'order-status';

            if (order.status === 'op_return_broadcasted') {
                statusClass += ' confirmed';
            } else if (order.status === 'payment_confirmed') {
                statusClass += ' confirmed';
            } else if (order.status === 'op_return_failed') {
                statusClass += ' failed';
                statusText = 'FAILED';
            } else if (order.status === 'refunded') {
                statusClass += ' confirmed';
                statusText = 'REFUNDED';
            } else if (order.status === 'refund_processing') {
                statusClass += ' failed';
                statusText = 'FAILED — refunding<span class="loading-dots"></span>';
            } else if (order.status === 'refund_failed') {
                statusClass += ' failed';
                statusText = 'FAILED — refund needs manual review';
            } else if (order.status === 'payment_detected') {
                statusClass += ' confirmed';
                statusText = 'Payment detected, awaiting confirmation<span class="loading-dots"></span>';
            }

            const mins = Math.floor((new Date() - new Date(order.createdAt)) / 60000);

            const isTerminal = order.status === 'op_return_broadcasted' || failed;
            const btnLabel = isTerminal ? 'REMOVE' : 'CANCEL';

            // Feedback box: only once the request has actually failed, and only until sent.
            let feedbackHtml = '';
            if (failed) {
                feedbackHtml = order.feedbackSent
                    ? `<div class="order-feedback-sent">Your message was sent to the operator. Thank you.</div>`
                    : `
                <div class="order-feedback">
                    <label for="fb-${order.requestId}">Something went wrong with this request. Leave a message for the operator:</label>
                    <textarea id="fb-${order.requestId}" class="feedback-input" data-id="${order.requestId}" maxlength="1000" placeholder="What happened, and how can we reach you?">${escapeHtml(feedbackDrafts[order.requestId] || '')}</textarea>
                    <div class="feedback-row">
                        <button class="order-btn feedback" data-id="${order.requestId}">SEND MESSAGE</button>
                        <span class="feedback-counter">0 / 1000</span>
                    </div>
                </div>`;
            }

            el.innerHTML = `
                <div class="order-header">
                    <span>${order.requestId.substring(0, 8)}...</span>
                    <span>${mins}m ago</span>
                </div>
                <div class="order-message">${escapeHtml(order.message)}</div>
                <div class="order-footer">
                    <div class="${statusClass}">${statusText}</div>
                    ${order.txId ? `<a href="https://mempool.space/tx/${order.txId}" target="_blank" class="order-link">VIEW TX</a>` : ''}
                </div>
                ${order.refundTxId ? `<div class="order-refund">Your payment was refunded — <a href="https://mempool.space/tx/${escapeHtml(order.refundTxId)}" target="_blank">view refund transaction</a></div>` : ''}
                ${failed && order.supportEmail ? `<div class="order-support">Need help? Contact <a href="mailto:${escapeHtml(order.supportEmail)}?subject=OP_RETURN%20failed%20request%20${order.requestId}">${escapeHtml(order.supportEmail)}</a></div>` : ''}
                ${feedbackHtml}
                <div class="order-actions">
                    ${order.status === 'pending_payment' ? `<button class="order-btn pay" data-id="${order.requestId}">PAY</button>` : ''}
                    <button class="order-btn ${isTerminal ? 'remove' : 'cancel'}" data-id="${order.requestId}">${btnLabel}</button>
                </div>
            `;

            const payBtn = el.querySelector('.order-btn.pay');
            if (payBtn) payBtn.addEventListener('click', () => openPaymentModal(order));

            const cancelBtn = el.querySelector('.order-btn.cancel');
            if (cancelBtn) cancelBtn.addEventListener('click', () => cancelOrder(order.requestId));

            const removeBtn = el.querySelector('.order-btn.remove');
            if (removeBtn) removeBtn.addEventListener('click', () => removeOrder(order.requestId));

            const feedbackBtn = el.querySelector('.order-btn.feedback');
            const feedbackInput = el.querySelector('.feedback-input');
            const feedbackCounter = el.querySelector('.feedback-counter');
            if (feedbackInput && feedbackCounter) {
                const syncCounter = () => {
                    const used = new TextEncoder().encode(feedbackInput.value).length;
                    feedbackCounter.textContent = `${used} / 1000`;
                };
                syncCounter();
                feedbackInput.addEventListener('input', () => {
                    feedbackDrafts[order.requestId] = feedbackInput.value;
                    syncCounter();
                });
            }
            if (feedbackBtn && feedbackInput) {
                feedbackBtn.addEventListener('click', () => submitFeedback(order.requestId, feedbackInput, feedbackBtn));
            }

            activeOrdersList.appendChild(el);
        });

        // Put the cursor back where the customer left it.
        if (focusedFeedbackId) {
            const restored = activeOrdersList.querySelector(`.feedback-input[data-id="${focusedFeedbackId}"]`);
            if (restored) {
                restored.focus();
                if (selectionStart !== null) {
                    try { restored.setSelectionRange(selectionStart, selectionStart); } catch { /* ignore */ }
                }
            }
        }
    }

    // --- API Calls ---
    async function executeProtocol() {
        const message = messageInput.value;
        if (!new TextEncoder().encode(message).length) {
            alert('Please enter a message.');
            return;
        }

        executeButton.disabled = true;
        executeButton.textContent = 'PROCESSING...';

        try {
            const body = {
                message,
                targetAddress: targetAddressInput.value.trim() || undefined,
                feeRate: parseInt(feeRateSlider.value),
                amountToSend: parseInt(amountInput.value) || 0
            };

            const response = await fetch('/api/message-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            const data = await response.json();

            if (response.ok) {
                addOrder({
                    requestId: data.requestId,
                    address: data.address,
                    requiredAmountSatoshis: data.requiredAmountSatoshis,
                    message
                });
                messageInput.value = '';
                updateByteCounter();
            } else {
                alert(`Error: ${data.error}`);
            }
        } catch (error) {
            alert('Network error. Check your connection.');
            console.error(error);
        } finally {
            executeButton.disabled = false;
            executeButton.textContent = 'BROADCAST';
        }
    }

    async function cancelOrder(requestId) {
        if (!confirm('Cancel this request?')) return;

        try {
            const res = await fetch(`/api/request/${requestId}`, {
                method: 'DELETE'
            });
            if (res.ok || res.status === 404) {
                removeOrder(requestId);
            } else {
                const data = await res.json();
                alert(`Failed: ${data.error}`);
            }
        } catch {
            alert('Network error.');
        }
    }

    async function submitFeedback(requestId, inputEl, buttonEl) {
        const text = inputEl.value.trim();
        if (!text) {
            alert('Please write a message first.');
            return;
        }

        buttonEl.disabled = true;
        const originalLabel = buttonEl.textContent;
        buttonEl.textContent = 'SENDING...';

        try {
            const res = await fetch(`/api/request/${encodeURIComponent(requestId)}/feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text })
            });
            const data = await res.json();

            if (res.ok) {
                const order = activeOrders.find(o => o.requestId === requestId);
                if (order) {
                    order.feedbackSent = true;
                    delete feedbackDrafts[requestId];
                    saveOrders();
                    renderOrders();
                }
            } else {
                alert(`Could not send message: ${data.error}`);
                buttonEl.disabled = false;
                buttonEl.textContent = originalLabel;
            }
        } catch {
            alert('Network error. Please try again.');
            buttonEl.disabled = false;
            buttonEl.textContent = originalLabel;
        }
    }

    async function pollActiveOrders() {
        if (activeOrders.length === 0) return;

        // Iterate a snapshot: updateOrderStatus re-renders and can mutate order objects.
        for (const order of [...activeOrders]) {
            // Keep polling failed orders — an automatic refund may still land.
            if (TERMINAL_STATUSES.includes(order.status)) continue;

            try {
                const res = await fetch(`/api/request-status/${order.requestId}`);
                if (!res.ok) continue;

                const data = await res.json();
                updateOrderStatus(order.requestId, data);
            } catch {
                // silent
            }
        }
    }

    function openPaymentModal(order) {
        modalPaymentAddress.textContent = order.address;
        modalRequiredAmount.textContent = `${order.requiredAmountSatoshis.toLocaleString()} sats`;
        paymentModal.style.display = 'flex';
    }

    // --- Event Listeners ---
    messageInput.addEventListener('input', () => { updateByteCounter(); updateCostBreakdown(); });
    targetAddressInput.addEventListener('input', updateCostBreakdown);
    amountInput.addEventListener('input', updateCostBreakdown);
    feeRateSlider.addEventListener('input', updateCostBreakdown);
    executeButton.addEventListener('click', executeProtocol);

    closePaymentModal.addEventListener('click', () => { paymentModal.style.display = 'none'; });
    window.addEventListener('click', (e) => { if (e.target === paymentModal) paymentModal.style.display = 'none'; });

    modalCopyAddressButton.addEventListener('click', () => {
        navigator.clipboard.writeText(modalPaymentAddress.textContent);
        modalCopyAddressButton.textContent = 'COPIED';
        setTimeout(() => { modalCopyAddressButton.textContent = 'COPY'; }, 2000);
    });

    // --- Init ---
    renderOrders();
    updateCostBreakdown();
    setInterval(pollActiveOrders, 5000);
});
