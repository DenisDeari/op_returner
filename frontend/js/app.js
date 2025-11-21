// frontend/js/app.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Constants & State ---
    const API_BASE_URL = '';
    const MAX_BYTES = 80;
    let statusIntervalId = null;
    let currentRequestId = null;
    let feedIntervalId = null;

    // --- DOM Elements ---
    const messageInput = document.getElementById('message-input');
    const targetAddressInput = document.getElementById('target-address-input');
    const publicFeedCheckbox = document.getElementById('public-feed-checkbox');
    const byteCounter = document.getElementById('byte-counter');
    const executeButton = document.getElementById('execute-button');
    const systemLog = document.getElementById('system-log');
    const recentMessagesList = document.getElementById('recent-messages-list');
    
    // Overlays
    const paymentOverlay = document.getElementById('payment-overlay');
    const successOverlay = document.getElementById('success-overlay');
    
    // Payment Elements
    const requiredAmountEl = document.getElementById('required-amount');
    const paymentAddressEl = document.getElementById('payment-address');
    const qrcodeContainer = document.getElementById('qrcode');
    const paymentStatusDisplay = document.getElementById('payment-status-display');
    const cancelButton = document.getElementById('cancel-button');
    const copyAddressButton = document.getElementById('copy-address-button');

    // Success Elements
    const finalTxIdEl = document.getElementById('final-tx-id');
    const explorerLink = document.getElementById('explorer-link');
    const resetButton = document.getElementById('reset-button');

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
     * Resets the UI state.
     */
    function resetState() {
        if (statusIntervalId) {
            clearTimeout(statusIntervalId);
            statusIntervalId = null;
        }
        localStorage.removeItem('activeRequestId');
        currentRequestId = null;

        messageInput.value = '';
        if (targetAddressInput) targetAddressInput.value = '';
        updateByteCounter();
        
        paymentOverlay.style.display = 'none';
        successOverlay.style.display = 'none';
        
        logToSystem('System ready for new transmission.');
    }

    /**
     * Cancels the current request.
     */
    async function cancelRequest() {
        if (confirm("Cancel current broadcast sequence?")) {
            if (currentRequestId) {
                try {
                    await fetch(`${API_BASE_URL}/api/request/${currentRequestId}`, {
                        method: 'DELETE'
                    });
                    logToSystem(`Request ${currentRequestId} cancelled.`);
                } catch (error) {
                    console.error("Error deleting request:", error);
                }
            }
            resetState();
        }
    }

    /**
     * Initiates the API request.
     */
    async function executeProtocol() {
        const message = messageInput.value;
        const targetAddress = targetAddressInput ? targetAddressInput.value.trim() : null;
        const isPublic = publicFeedCheckbox.checked;
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
                    isPublic: isPublic
                }),
            });

            const responseData = await response.json();

            if (response.ok && response.status === 201) {
                currentRequestId = responseData.requestId;
                localStorage.setItem('activeRequestId', currentRequestId);
                
                logToSystem('Payment gateway initialized.');
                showPaymentOverlay(responseData);
                checkStatus(currentRequestId);
            } else {
                logToSystem(`Error: ${responseData.error}`);
                alert(`Error: ${responseData.error}`);
            }
        } catch (error) {
            logToSystem('Network connection failed.');
            console.error("Error:", error);
        }
    }

    function showPaymentOverlay(data) {
        paymentAddressEl.textContent = data.address;
        requiredAmountEl.textContent = `${data.requiredAmountSatoshis} SATS`;
        
        qrcodeContainer.innerHTML = '';
        new QRCode(qrcodeContainer, {
            text: `bitcoin:${data.address}?amount=${data.requiredAmountSatoshis / 100000000}`,
            width: 150,
            height: 150,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.M
        });

        paymentOverlay.style.display = 'flex';
    }

    async function checkStatus(requestId) {
        if (!requestId) return;

        try {
            const response = await fetch(`${API_BASE_URL}/api/request-status/${requestId}`);
            if (!response.ok) return;

            const data = await response.json();

            // Restore payment info if needed
            if (data.address && data.requiredAmountSatoshis && paymentOverlay.style.display === 'none' && successOverlay.style.display === 'none') {
                 showPaymentOverlay(data);
            }

            switch (data.status) {
                case 'pending_payment':
                    paymentStatusDisplay.textContent = 'Waiting for funds...';
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 5000);
                    break;
                case 'payment_detected':
                    paymentStatusDisplay.textContent = 'Payment detected. Awaiting confirmation...';
                    if (paymentStatusDisplay.textContent !== 'Payment detected. Awaiting confirmation...') {
                        logToSystem('Payment signal detected. Verifying...');
                    }
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 5000);
                    break;
                case 'payment_confirmed':
                    paymentStatusDisplay.textContent = 'Payment confirmed. Broadcasting...';
                    logToSystem('Funds secured. Broadcasting OP_RETURN...');
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 3000);
                    break;
                case 'op_return_broadcasted':
                    clearTimeout(statusIntervalId);
                    paymentOverlay.style.display = 'none';
                    successOverlay.style.display = 'flex';
                    
                    finalTxIdEl.textContent = data.opReturnTxId;
                    explorerLink.href = `https://mempool.space/tx/${data.opReturnTxId}`;
                    
                    logToSystem('Sequence complete. Message immutable.');
                    logToSystem(`TXID: ${data.opReturnTxId}`);
                    
                    // Refresh feed immediately after success
                    fetchRecentMessages();
                    break;
                case 'op_return_failed':
                    paymentStatusDisplay.textContent = 'Broadcast failed. Contact support.';
                    logToSystem('Critical Error: Broadcast failed.');
                    clearTimeout(statusIntervalId);
                    break;
            }
        } catch (error) {
            console.error("Status check error:", error);
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
    executeButton.addEventListener('click', executeProtocol);
    cancelButton.addEventListener('click', cancelRequest);
    resetButton.addEventListener('click', resetState);
    
    copyAddressButton.addEventListener('click', () => {
        navigator.clipboard.writeText(paymentAddressEl.textContent);
        const originalText = copyAddressButton.textContent;
        copyAddressButton.textContent = 'COPIED';
        setTimeout(() => copyAddressButton.textContent = originalText, 2000);
    });

    // --- Init ---
    if (window.location.protocol === 'file:') {
        logToSystem('WARNING: Running via file protocol. API calls will fail.');
    }

    const savedRequestId = localStorage.getItem('activeRequestId');
    if (savedRequestId) {
        currentRequestId = savedRequestId;
        logToSystem('Resuming previous session...');
        checkStatus(currentRequestId);
    }

    // Initial fetch and periodic update for feed
    fetchRecentMessages();
    feedIntervalId = setInterval(fetchRecentMessages, 30000); // Update every 30s
});
