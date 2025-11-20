// frontend/js/app.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Constants & State ---
    const API_BASE_URL = '';
    const MAX_BYTES = 80;
    let statusIntervalId = null;
    let currentRequestId = null;

    // --- DOM Elements ---
    const messageInput = document.getElementById('message-input');
    const targetAddressInput = document.getElementById('target-address-input');
    const byteCounter = document.getElementById('byte-counter');
    const executeButton = document.getElementById('execute-button');
    const systemLog = document.getElementById('system-log');
    
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
     * Adds a message to the system log with a typewriter effect.
     */
    function logToSystem(message, type = 'info') {
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.textContent = `> ${message}`;
        
        // Remove cursor from previous last element
        const oldCursor = systemLog.querySelector('.cursor');
        if (oldCursor) oldCursor.remove();

        // Add new cursor
        const cursorSpan = document.createElement('span');
        cursorSpan.className = 'cursor';
        cursorSpan.textContent = '_';
        logEntry.appendChild(cursorSpan);

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
            byteCounter.style.color = '#ff0000';
        } else {
            byteCounter.style.color = '#444';
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
        
        logToSystem('SYSTEM RESET. READY FOR NEW INPUT.');
    }

    /**
     * Cancels the current request.
     */
    async function cancelRequest() {
        if (confirm("ABORT SEQUENCE? THIS ACTION IS IRREVERSIBLE.")) {
            if (currentRequestId) {
                try {
                    await fetch(`${API_BASE_URL}/api/request/${currentRequestId}`, {
                        method: 'DELETE'
                    });
                    logToSystem(`REQUEST ${currentRequestId} TERMINATED.`);
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
        const byteLength = new TextEncoder().encode(message).length;

        if (byteLength === 0) {
            logToSystem('ERROR: PAYLOAD EMPTY. ABORTING.');
            alert("ERROR: PAYLOAD EMPTY.");
            return;
        }

        logToSystem('INITIATING PROTOCOL...');
        logToSystem('ENCODING PAYLOAD...');

        try {
            const response = await fetch(`${API_BASE_URL}/api/message-request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message, targetAddress: targetAddress }),
            });

            const responseData = await response.json();

            if (response.ok && response.status === 201) {
                currentRequestId = responseData.requestId;
                localStorage.setItem('activeRequestId', currentRequestId);
                
                logToSystem('PAYMENT GATEWAY OPENED.');
                showPaymentOverlay(responseData);
                checkStatus(currentRequestId);
            } else {
                logToSystem(`ERROR: ${responseData.error}`);
                alert(`ERROR: ${responseData.error}`);
            }
        } catch (error) {
            logToSystem('CRITICAL NETWORK FAILURE.');
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
                    paymentStatusDisplay.textContent = 'WAITING_FOR_FUNDS...';
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 5000);
                    break;
                case 'payment_detected':
                    paymentStatusDisplay.textContent = 'PAYMENT DETECTED. AWAITING CONFIRMATION...';
                    logToSystem('PAYMENT SIGNAL DETECTED. VERIFYING...');
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 5000);
                    break;
                case 'payment_confirmed':
                    paymentStatusDisplay.textContent = 'PAYMENT CONFIRMED. BROADCASTING...';
                    logToSystem('FUNDS SECURED. BROADCASTING OP_RETURN...');
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 3000);
                    break;
                case 'op_return_broadcasted':
                    clearTimeout(statusIntervalId);
                    paymentOverlay.style.display = 'none';
                    successOverlay.style.display = 'flex';
                    
                    finalTxIdEl.textContent = data.opReturnTxId;
                    explorerLink.href = `https://mempool.space/tx/${data.opReturnTxId}`;
                    
                    logToSystem('SEQUENCE COMPLETE. IMMUTABILITY ACHIEVED.');
                    logToSystem(`TXID: ${data.opReturnTxId}`);
                    break;
                case 'op_return_failed':
                    paymentStatusDisplay.textContent = 'BROADCAST FAILED. CONTACT SUPPORT.';
                    logToSystem('CRITICAL ERROR: BROADCAST FAILED.');
                    clearTimeout(statusIntervalId);
                    break;
            }
        } catch (error) {
            console.error("Status check error:", error);
        }
    }

    // --- Event Listeners ---
    messageInput.addEventListener('input', updateByteCounter);
    executeButton.addEventListener('click', executeProtocol);
    cancelButton.addEventListener('click', cancelRequest);
    resetButton.addEventListener('click', resetState);
    
    copyAddressButton.addEventListener('click', () => {
        navigator.clipboard.writeText(paymentAddressEl.textContent);
        const originalText = copyAddressButton.textContent;
        copyAddressButton.textContent = '[COPIED]';
        setTimeout(() => copyAddressButton.textContent = originalText, 2000);
    });

    // --- Init ---
    const savedRequestId = localStorage.getItem('activeRequestId');
    if (savedRequestId) {
        currentRequestId = savedRequestId;
        logToSystem('RESUMING PREVIOUS SESSION...');
        checkStatus(currentRequestId);
    }
});