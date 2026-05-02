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

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
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

    function updateOrderStatus(requestId, status, txId = null, supportEmail = null) {
        const order = activeOrders.find(o => o.requestId === requestId);
        if (order && order.status !== status) {
            order.status = status;
            if (txId) order.txId = txId;
            if (supportEmail) order.supportEmail = supportEmail;
            saveOrders();
            renderOrders();
        }
    }

    function renderOrders() {
        activeOrdersList.innerHTML = '';

        if (activeOrders.length === 0) {
            activeOrdersList.innerHTML = '<p class="placeholder">No active requests.</p>';
            return;
        }

        activeOrders.forEach(order => {
            const el = document.createElement('div');
            el.className = `order-item${order.status === 'op_return_failed' ? ' failed' : ''}`;

            let statusText = order.status.replace(/_/g, ' ').toUpperCase();
            let statusClass = 'order-status';

            if (order.status === 'op_return_broadcasted') {
                statusClass += ' confirmed';
            } else if (order.status === 'payment_confirmed') {
                statusClass += ' confirmed';
            } else if (order.status === 'op_return_failed') {
                statusClass += ' failed';
                statusText = 'FAILED';
            } else if (order.status === 'payment_detected') {
                statusClass += ' confirmed';
                statusText = 'Payment detected, awaiting confirmation<span class="loading-dots"></span>';
            }

            const mins = Math.floor((new Date() - new Date(order.createdAt)) / 60000);

            const isTerminal = order.status === 'op_return_broadcasted' || order.status === 'op_return_failed';
            const btnLabel = isTerminal ? 'REMOVE' : 'CANCEL';

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
                ${order.status === 'op_return_failed' && order.supportEmail ? `<div class="order-support">Need help? Contact <a href="mailto:${escapeHtml(order.supportEmail)}?subject=OP_RETURN%20failed%20request%20${order.requestId}">${escapeHtml(order.supportEmail)}</a></div>` : ''}
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

            activeOrdersList.appendChild(el);
        });
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

    async function pollActiveOrders() {
        if (activeOrders.length === 0) return;

        for (const order of activeOrders) {
            if (order.status === 'op_return_broadcasted' || order.status === 'op_return_failed') continue;

            try {
                const res = await fetch(`/api/request-status/${order.requestId}`);
                if (!res.ok) continue;

                const data = await res.json();
                if (data.status !== order.status) {
                    updateOrderStatus(order.requestId, data.status, data.opReturnTxId, data.supportEmail);
                }
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
