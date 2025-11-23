// frontend/js/app.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Constants & State ---
    const API_BASE_URL = '';
    const MAX_BYTES = 80;
    let statusIntervalId = null;
    let feedIntervalId = null;
    
    // State: Array of active order IDs
    let activeOrders = JSON.parse(localStorage.getItem('satwire_orders')) || [];

    // --- DOM Elements ---
    const messageInput = document.getElementById('message-input');
    const targetAddressInput = document.getElementById('target-address-input');
    const publicFeedCheckbox = document.getElementById('public-feed-checkbox');
    const amountInput = document.getElementById('amount-input');
    const refundAddressInput = document.getElementById('refund-address-input');
    const feeRateSlider = document.getElementById('fee-rate-slider');
    const feeRateDisplay = document.getElementById('fee-rate-display');
    const costNetworkFee = document.getElementById('cost-network-fee');
    const costRecipientAmount = document.getElementById('cost-recipient-amount');
    const costTotal = document.getElementById('cost-total');
    const byteCounter = document.getElementById('byte-counter');
    const executeButton = document.getElementById('execute-button');
    const systemLog = document.getElementById('system-log');
    const recentMessagesList = document.getElementById('recent-messages-list');
    const activeOrdersList = document.getElementById('active-orders-list');
    
    // Modal Elements
    const paymentModal = document.getElementById('payment-modal');
    const closePaymentModal = document.getElementById('close-payment-modal');
    const modalRequiredAmount = document.getElementById('modal-required-amount');
    const modalPaymentAddress = document.getElementById('modal-payment-address');
    const modalQrcodeContainer = document.getElementById('modal-qrcode');
    const modalCopyAddressButton = document.getElementById('modal-copy-address-button');

    // --- Helper Functions ---

    /**
     * Adds a message to the system log.
     */
    function logToSystem(message) {
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        
        const timestamp = new Date().toLocaleTimeString([], { hour12: false });
        logEntry.textContent = `[${timestamp}] ${message}`;
        
        systemLog.appendChild(logEntry);
        systemLog.scrollTop = systemLog.scrollHeight;
    }

    /**
     * Updates the cost breakdown.
     */
    function updateCostBreakdown() {
        const feeRate = parseInt(feeRateSlider.value);
        const amountToSend = parseInt(amountInput.value) || 0;
        
        feeRateDisplay.textContent = feeRate;

        const estimatedVBytes = 200;
        const networkFee = estimatedVBytes * feeRate;
        const serviceFee = 2000;
        const total = networkFee + serviceFee + amountToSend;

        costNetworkFee.textContent = `~${networkFee} sats`;
        costRecipientAmount.textContent = `${amountToSend} sats`;
        costTotal.textContent = `~${total} sats`;
    }

    /**
     * Updates the byte counter.
     */
    function updateByteCounter() {
        const message = messageInput.value;
        const byteLength = new TextEncoder().encode(message).length;

        if (byteLength > MAX_BYTES) {
            let currentMessage = message;
            while (new TextEncoder().encode(currentMessage).length > MAX_BYTES) {
                currentMessage = currentMessage.slice(0, -1);
            }
            messageInput.value = currentMessage;
            updateByteCounter();
            return;
        }

        byteCounter.textContent = `${byteLength} / ${MAX_BYTES} BYTES`;
        
        if (byteLength >= MAX_BYTES) {
            byteCounter.style.color = '#d32f2f';
        } else {
            byteCounter.style.color = '#888';
        }
    }

    /**
     * Saves active orders to LocalStorage.
     */
    function saveOrders() {
        localStorage.setItem('satwire_orders', JSON.stringify(activeOrders));
    }

    /**
     * Adds a new order to the list.
     */
    function addOrder(orderData) {
        // Check if already exists
        if (!activeOrders.find(o => o.requestId === orderData.requestId)) {
            activeOrders.unshift({
                ...orderData,
                status: 'pending_payment',
                createdAt: new Date().toISOString()
            });
            saveOrders();
            renderOrders();
        }
    }

    /**
     * Removes an order from the list.
     */
    function removeOrder(requestId) {
        activeOrders = activeOrders.filter(o => o.requestId !== requestId);
        saveOrders();
        renderOrders();
    }

    /**
     * Updates an order's status.
     */
    function updateOrderStatus(requestId, status, txId = null) {
        const order = activeOrders.find(o => o.requestId === requestId);
        if (order) {
            if (order.status !== status) {
                order.status = status;
                if (txId) order.txId = txId;
                saveOrders();
                renderOrders();
            }
        }
    }

    /**
     * Renders the list of active orders.
     */
    function renderOrders() {
        activeOrdersList.innerHTML = '';

        if (activeOrders.length === 0) {
            activeOrdersList.innerHTML = `
                <div class="order-item-placeholder" style="color: var(--text-dim); font-size: 0.8rem; text-align: center; padding-top: 20px;">
                    No active transmissions.
                </div>`;
            return;
        }

        activeOrders.forEach(order => {
            const item = document.createElement('div');
            item.className = `order-item ${order.status === 'op_return_failed' ? 'failed' : ''}`;
            
            let statusText = order.status.replace('_', ' ').toUpperCase();
            let statusClass = 'order-status';
            
            if (order.status === 'payment_confirmed' || order.status === 'op_return_broadcasted') {
                statusClass += ' confirmed';
            } else if (order.status === 'op_return_failed') {
                statusClass += ' failed';
                statusText = "FAILED - REFUND NEEDED";
            } else if (order.status === 'payment_detected') {
                statusClass += ' confirmed'; // Use green/confirmed color for positive progress
                statusText = 'Payment detected, waiting for one confirmation<span class="loading-dots"></span>';
            }

            const timeAgo = Math.floor((new Date() - new Date(order.createdAt)) / 60000); // minutes

            // Determine button text and class based on status
            let deleteBtnText = "CANCEL";
            let deleteBtnClass = "cancel-btn";
            
            if (order.status === 'op_return_broadcasted' || order.status === 'op_return_failed') {
                deleteBtnText = "DELETE FROM WEBSITE";
                deleteBtnClass = "delete-local-btn";
            }

            item.innerHTML = `
                <div class="order-header">
                    <span>ID: ${order.requestId.substring(0, 8)}...</span>
                    <span>${timeAgo} min ago</span>
                </div>
                <div class="order-message" style="font-size: 0.9rem; color: var(--text-main); word-break: break-all;">
                    "${escapeHtml(order.message)}"
                </div>
                <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 15px;">
                    <div class="${statusClass}">${statusText}</div>
                    ${order.txId ? `<a href="https://mempool.space/tx/${order.txId}" target="_blank" class="terminal-link" style="margin: 0;">VIEW TX</a>` : ''}
                </div>
                
                <div class="order-actions">
                    ${order.status === 'pending_payment' ? `<button class="order-button pay-btn" data-id="${order.requestId}">PAY / QR</button>` : ''}
                    <button class="order-button ${deleteBtnClass}" data-id="${order.requestId}">${deleteBtnText}</button>
                </div>
            `;

            // Event Listeners for buttons
            const payBtn = item.querySelector('.pay-btn');
            if (payBtn) {
                payBtn.addEventListener('click', () => openPaymentModal(order));
            }

            const cancelBtn = item.querySelector('.cancel-btn');
            if (cancelBtn) {
                cancelBtn.addEventListener('click', () => cancelOrder(order.requestId));
            }

            const deleteLocalBtn = item.querySelector('.delete-local-btn');
            if (deleteLocalBtn) {
                deleteLocalBtn.addEventListener('click', () => {
                    if (confirm("This will only remove the order from your local view. The transaction on the blockchain remains. Continue?")) {
                        removeOrder(order.requestId);
                    }
                });
            }

            activeOrdersList.appendChild(item);
        });
    }

    /**
     * Cancels an order on the server and removes it locally.
     */
    async function cancelOrder(requestId) {
        if (!confirm("Are you sure you want to cancel this order? It will be permanently removed.")) {
            return;
        }

        logToSystem(`Cancelling order ${requestId.substring(0, 8)}...`);

        try {
            const response = await fetch(`${API_BASE_URL}/api/request/${requestId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                logToSystem(`Order ${requestId.substring(0, 8)} cancelled.`);
                removeOrder(requestId);
            } else {
                const data = await response.json();
                // If 404, it's already gone, so remove locally
                if (response.status === 404) {
                    logToSystem(`Order ${requestId.substring(0, 8)} not found on server. Removing locally.`);
                    removeOrder(requestId);
                } else {
                    logToSystem(`Error cancelling: ${data.error || response.statusText}`);
                    alert(`Failed to cancel: ${data.error}`);
                }
            }
        } catch (error) {
            logToSystem(`Network error during cancellation.`);
            console.error("Cancel error:", error);
        }
    }

    function openPaymentModal(order) {
        modalPaymentAddress.textContent = order.address;
        modalRequiredAmount.textContent = `${order.requiredAmountSatoshis} SATS`;
        
        modalQrcodeContainer.innerHTML = '';
        new QRCode(modalQrcodeContainer, {
            text: `bitcoin:${order.address}?amount=${order.requiredAmountSatoshis / 100000000}`,
            width: 200,
            height: 200,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });

        paymentModal.style.display = 'flex';
    }

    function closePaymentModalFunc() {
        paymentModal.style.display = 'none';
    }

    /**
     * Initiates the API request.
     */
    async function executeProtocol() {
        const message = messageInput.value;
        const targetAddress = targetAddressInput ? targetAddressInput.value.trim() : null;
        const isPublic = publicFeedCheckbox.checked;
        const feeRate = parseInt(feeRateSlider.value);
        const amountToSend = parseInt(amountInput.value) || 0;
        const refundAddress = refundAddressInput ? refundAddressInput.value.trim() : null;
        const byteLength = new TextEncoder().encode(message).length;

        if (byteLength === 0) {
            logToSystem('Error: Payload is empty.');
            alert("Please enter a message.");
            return;
        }

        logToSystem('Initiating broadcast sequence...');
        
        try {
            const response = await fetch(`${API_BASE_URL}/api/message-request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    message: message, 
                    targetAddress: targetAddress,
                    isPublic: isPublic,
                    feeRate: feeRate,
                    amountToSend: amountToSend,
                    refundAddress: refundAddress
                }),
            });

            const responseData = await response.json();

            if (response.ok && response.status === 201) {
                logToSystem(`Order created: ${responseData.requestId}`);
                
                // Add to active orders list
                addOrder({
                    requestId: responseData.requestId,
                    address: responseData.address,
                    requiredAmountSatoshis: responseData.requiredAmountSatoshis,
                    message: message // Store message for display
                });

                // Clear inputs
                messageInput.value = '';
                updateByteCounter();
                
            } else {
                logToSystem(`Error: ${responseData.error}`);
                alert(`Error: ${responseData.error}`);
            }
        } catch (error) {
            logToSystem('Network connection failed.');
            console.error("Error:", error);
        }
    }

    /**
     * Polls status for all active orders.
     */
    async function pollActiveOrders() {
        if (activeOrders.length === 0) return;

        for (const order of activeOrders) {
            // Skip completed or failed orders to save bandwidth, unless we want to check for confirmations
            if (order.status === 'op_return_broadcasted' || order.status === 'op_return_failed') continue;

            try {
                const response = await fetch(`${API_BASE_URL}/api/request-status/${order.requestId}`);
                if (!response.ok) {
                    if (response.status === 404) {
                        // Order might have been deleted on backend
                        // updateOrderStatus(order.requestId, 'expired'); 
                    }
                    continue;
                }

                const data = await response.json();
                
                if (data.status !== order.status) {
                    logToSystem(`Order ${order.requestId.substring(0,8)}: ${data.status}`);
                    updateOrderStatus(order.requestId, data.status, data.opReturnTxId);
                    
                    if (data.status === 'op_return_broadcasted') {
                        fetchRecentMessages(); // Refresh feed
                    }
                }
            } catch (error) {
                console.error(`Error polling order ${order.requestId}:`, error);
            }
        }
    }

    /**
     * Fetches and displays recent public messages.
     */
    async function fetchRecentMessages() {
        try {
            const response = await fetch(`${API_BASE_URL}/api/recent-messages`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const messages = await response.json();
            renderRecentMessages(messages);
        } catch (error) {
            console.error("Error fetching recent messages:", error);
            renderErrorState();
        }
    }

    function renderErrorState() {
        recentMessagesList.innerHTML = '';
        const errorItem = document.createElement('div');
        errorItem.className = 'recent-message-item';
        errorItem.innerHTML = '<div class="recent-message-text" style="color: #d32f2f;">System Offline: Feed Unavailable</div>';
        recentMessagesList.appendChild(errorItem);
    }

    function renderRecentMessages(messages) {
        recentMessagesList.innerHTML = '';

        if (messages.length === 0) {
            const emptyItem = document.createElement('div');
            emptyItem.className = 'recent-message-item';
            emptyItem.innerHTML = '<div class="recent-message-text" style="color: #666;">No recent public broadcasts.</div>';
            recentMessagesList.appendChild(emptyItem);
            return;
        }

        messages.forEach(msg => {
            const item = document.createElement('div');
            item.className = 'recent-message-item';
            
            const date = new Date(msg.createdAt).toLocaleString();
            const txIdShort = msg.opReturnTxId ? `${msg.opReturnTxId.substring(0, 8)}...` : 'Pending';
            
            item.innerHTML = `
                <div class="recent-message-text">${escapeHtml(msg.message)}</div>
                <div class="recent-message-meta">
                    <span>${date}</span>
                    <a href="https://mempool.space/tx/${msg.opReturnTxId}" target="_blank" class="recent-message-link">TX: ${txIdShort}</a>
                </div>
            `;
            recentMessagesList.appendChild(item);
        });
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // --- Event Listeners ---
    messageInput.addEventListener('input', updateByteCounter);
    amountInput.addEventListener('input', updateCostBreakdown);
    feeRateSlider.addEventListener('input', updateCostBreakdown);
    executeButton.addEventListener('click', executeProtocol);
    
    closePaymentModal.addEventListener('click', closePaymentModalFunc);
    window.addEventListener('click', (event) => {
        if (event.target === paymentModal) {
            closePaymentModalFunc();
        }
    });
    
    modalCopyAddressButton.addEventListener('click', () => {
        navigator.clipboard.writeText(modalPaymentAddress.textContent);
        const originalText = modalCopyAddressButton.textContent;
        modalCopyAddressButton.textContent = 'COPIED';
        setTimeout(() => modalCopyAddressButton.textContent = originalText, 2000);
    });

    // --- Init ---
    if (window.location.protocol === 'file:') {
        logToSystem('WARNING: Running via file protocol. API calls will fail.');
    }

    // Initial Render
    renderOrders();
    fetchRecentMessages();
    updateCostBreakdown();

    // Intervals
    feedIntervalId = setInterval(fetchRecentMessages, 30000); // Feed every 30s
    statusIntervalId = setInterval(pollActiveOrders, 5000); // Poll orders every 5s
});
