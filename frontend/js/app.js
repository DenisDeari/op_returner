// frontend/js/app.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Constants & State ---
    const API_BASE_URL = '';
    const MAX_BYTES = 80;
    let statusIntervalId = null;
    let currentRequestId = null;

    // --- DOM Elements for Step 1: Compose ---
    const messageInput = document.getElementById('message-input');
    const byteCounterSpan = document.getElementById('byte-counter-span');
    const progressBar = document.getElementById('progress-bar');
    const sealMessageButton = document.getElementById('seal-message-button');

    // --- DOM Elements for Step 2: Seal & Confirm ---
    const composeStep = document.getElementById('compose-step');
    const sealingStep = document.getElementById('sealing-step');
    const finalMessageReview = document.getElementById('final-message-review');
    const confirmSealButton = document.getElementById('confirm-seal-button');
    const editMessageButton = document.getElementById('edit-message-button');
    const cancelStep2Button = document.getElementById('cancel-step2-button');

    // --- DOM Elements for Step 3: Payment ---
    const paymentStep = document.getElementById('payment-step');
    const requiredAmountEl = document.getElementById('required-amount');
    const paymentAddressEl = document.getElementById('payment-address');
    const qrcodeContainer = document.getElementById('qrcode');
    const paymentStatusDisplay = document.getElementById('payment-status-display');
    const processingIndicator = document.getElementById('processing-indicator');
    const cancelStep3Button = document.getElementById('cancel-step3-button');
    const copyAddressButton = document.getElementById('copy-address-button');

    // --- DOM Elements for Step 4: Success ---
    const successStep = document.getElementById('success-step');
    const finalTxIdEl = document.getElementById('final-tx-id');
    const explorerLink = document.getElementById('explorer-link');
    const createNewMessageButton = document.getElementById('create-new-message-button');

    // --- Functions from your original app.js (adapted for the new UI) ---

    /**
     * Updates the byte counter and progress bar based on user input.
     */
    function updateByteCounter() {
        const message = messageInput.value;
        // Using TextEncoder is the most accurate way to measure byte length for UTF-8.
        const byteLength = new TextEncoder().encode(message).length;

        // Prevent user from exceeding the max byte limit
        if (byteLength > MAX_BYTES) {
            // Wir entfernen solange das letzte Zeichen, bis wir wieder unter dem Limit sind.
            // Das verhindert halbe Bytes bei Emojis.
            let currentMessage = message;
            while (new TextEncoder().encode(currentMessage).length > MAX_BYTES) {
                currentMessage = currentMessage.slice(0, -1);
            }
            messageInput.value = currentMessage;
            updateByteCounter(); // Neu berechnen
            return;
        }

        byteCounterSpan.textContent = `${byteLength} / ${MAX_BYTES} bytes`;
        const percentage = (byteLength / MAX_BYTES) * 100;
        progressBar.style.width = `${percentage}%`;

        // Change progress bar color if limit is reached
        if (byteLength >= MAX_BYTES) {
            progressBar.style.backgroundColor = '#d9534f'; // A red warning color
        } else {
            progressBar.style.background = 'linear-gradient(90deg, #ff9900, #ff5f6d)'; // Reset to gradient
        }
    }


    /**
     * Transitions the UI from one step to another.
     * @param {string} currentStepId - The ID of the current step to hide.
     * @param {string} nextStepId - The ID of the next step to show.
     */
    function transitionToStep(currentStepId, nextStepId) {
        document.getElementById(currentStepId).classList.remove('active');
        document.getElementById(nextStepId).classList.add('active');
    }


    /**
     * Resets the entire UI to the initial composing step.
     * (Replaces your original resetToInputState function)
     */
    function resetToComposeState() {
        // Clear any polling intervals
        if (statusIntervalId) {
            clearTimeout(statusIntervalId);
            statusIntervalId = null;
        }

        // Clear local storage and state
        localStorage.removeItem('activeRequestId');
        currentRequestId = null;

        // Reset input fields
        messageInput.value = '';
        finalMessageReview.textContent = '';
        qrcodeContainer.innerHTML = '';
        paymentStatusDisplay.textContent = 'Waiting for payment...';

        // Reset progress bar and counter
        updateByteCounter();

        // Show the first step and hide others
        composeStep.classList.add('active');
        sealingStep.classList.remove('active');
        paymentStep.classList.remove('active');
        successStep.classList.remove('active');

        // Re-enable buttons
        sealMessageButton.disabled = false;
        confirmSealButton.disabled = false;
        confirmSealButton.textContent = 'Confirm & Create Request';
    }


    /**
     * Cancels the current request and resets the UI.
     */
    async function cancelRequest() {
        if (confirm("Are you sure you want to cancel? This will delete your request.")) {
            if (currentRequestId) {
                try {
                    await fetch(`${API_BASE_URL}/api/request/${currentRequestId}`, {
                        method: 'DELETE'
                    });
                    console.log(`Request ${currentRequestId} deleted.`);
                } catch (error) {
                    console.error("Error deleting request:", error);
                }
            }
            resetToComposeState();
        }
    }

    /**
     * Initiates the API request to get a payment address.
     * (This is the core of your original submitButton click handler).
     */
    async function createMessageRequest() {
        const message = messageInput.value;
        const byteLength = new TextEncoder().encode(message).length;

        if (byteLength === 0) {
            alert("Please enter a message to immortalize.");
            return;
        }
        if (byteLength > MAX_BYTES) {
            alert(`Your message is ${byteLength} bytes, which exceeds the ${MAX_BYTES} byte limit.`);
            return;
        }

        confirmSealButton.disabled = true;
        confirmSealButton.textContent = 'Requesting...';

        try {
            const response = await fetch(`${API_BASE_URL}/api/message-request`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: message }),
            });

            const responseData = await response.json();

            if (response.ok && response.status === 201) {
                // Success! We have the payment info.
                currentRequestId = responseData.requestId;
                localStorage.setItem('activeRequestId', currentRequestId); // Persist for page reloads
                showPaymentInfo(responseData);
                transitionToStep('sealing-step', 'payment-step');
                checkStatus(currentRequestId); // Start polling for payment
            } else {
                // Handle server-side errors
                alert(`Error: ${responseData.error || 'Failed to create the request. Please try again.'}`);
                confirmSealButton.disabled = false;
                confirmSealButton.textContent = 'Confirm & Create Request';
            }
        } catch (error) {
            console.error("Error creating message request:", error);
            alert("A network error occurred. Could not connect to the server.");
            confirmSealButton.disabled = false;
            confirmSealButton.textContent = 'Confirm & Create Request';
        }
    }


    /**
     * Displays the QR code and payment details.
     * (Adapted from your original showPaymentInfo function).
     * @param {object} requestData - The data object from the /api/message-request response.
     */
    function showPaymentInfo(requestData) {
        paymentAddressEl.textContent = requestData.address;
        requiredAmountEl.textContent = `${requestData.requiredAmountSatoshis} SATs`;

        qrcodeContainer.innerHTML = ''; // Clear previous QR code
        try {
            new QRCode(qrcodeContainer, {
                text: `bitcoin:${requestData.address}?amount=${requestData.requiredAmountSatoshis / 100000000}`,
                width: 150,
                height: 150,
                colorDark: "#e0e0e0",
                colorLight: "rgba(23, 28, 58, 0.7)",
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch (e) {
            console.error("Failed to generate QR code:", e);
            qrcodeContainer.textContent = 'Error generating QR code.';
        }
    }

    /**
     * Polls the backend for the status of a request.
     * (This is your original checkStatus function, with UI updates adapted for the new layout).
     */
    async function checkStatus(requestId) {
        console.log(`Checking status for ${requestId}...`);
        if (!requestId) return;

        try {
            const response = await fetch(`${API_BASE_URL}/api/request-status/${requestId}`);

            if (!response.ok) {
                // Handle non-200 responses (like 404)
                paymentStatusDisplay.textContent = `Error checking status (${response.status}).`;
                clearTimeout(statusIntervalId);
                return;
            }

            const data = await response.json();
            console.log("Status data:", data);

            // Restore payment info if missing (e.g. after refresh)
            if (data.address && data.requiredAmountSatoshis) {
                 if (paymentAddressEl.textContent === '...' || paymentAddressEl.textContent !== data.address) {
                     showPaymentInfo(data);
                 }
            }

            // Update UI based on status
            processingIndicator.style.display = 'none'; // Hide by default

            switch (data.status) {
                case 'pending_payment':
                    paymentStatusDisplay.textContent = 'Waiting for payment...';
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 10000); // Poll every 10s
                    break;
                case 'payment_detected':
                    paymentStatusDisplay.textContent = 'Payment detected! Awaiting confirmation...';
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 10000); // Poll every 10s
                    break;
                case 'payment_confirmed':
                    paymentStatusDisplay.textContent = 'Payment Confirmed! Broadcasting to the blockchain...';
                    processingIndicator.style.display = 'block'; // Show spinner
                    qrcodeContainer.style.display = 'none'; // Hide QR code
                    statusIntervalId = setTimeout(() => checkStatus(requestId), 5000); // Poll faster
                    break;
                case 'op_return_broadcasted':
                    // --- SUCCESS ---
                    paymentStatusDisplay.textContent = 'Message Broadcast Successfully!';
                    clearTimeout(statusIntervalId);
                    showSuccessInfo(data);
                    transitionToStep('payment-step', 'success-step');
                    break;
                case 'op_return_failed':
                    paymentStatusDisplay.textContent = 'Error: Failed to broadcast your message. Please contact support.';
                    processingIndicator.style.display = 'none';
                    clearTimeout(statusIntervalId);
                    break;
                default:
                    paymentStatusDisplay.textContent = `Status: ${data.status.replace(/_/g, ' ')}`;
                    clearTimeout(statusIntervalId); // Stop polling for unknown statuses
            }

        } catch (error) {
            console.error("Network error fetching status:", error);
            paymentStatusDisplay.textContent = "Network error while checking status.";
            clearTimeout(statusIntervalId);
        }
    }

    /**
     * Displays the final success information.
     * @param {object} successData - The data object from the final status check.
     */
    function showSuccessInfo(successData) {
        finalTxIdEl.textContent = successData.opReturnTxId || 'N/A';
        explorerLink.href = `https://mempool.space/tx/${successData.opReturnTxId}`;
    }


    // --- Event Listeners ---

    messageInput.addEventListener('input', updateByteCounter);

    // --- Step 1 to Step 2 Transition ---
    sealMessageButton.addEventListener('click', () => {
        if (new TextEncoder().encode(messageInput.value).length === 0) {
            alert("Please write a message first!");
            return;
        }
        finalMessageReview.textContent = messageInput.value;
        transitionToStep('compose-step', 'sealing-step');
    });

    // --- Step 2 to Step 1 (Edit) ---
    editMessageButton.addEventListener('click', () => {
        transitionToStep('sealing-step', 'compose-step');
    });

    // --- Step 2 Cancel ---
    cancelStep2Button.addEventListener('click', () => {
        // For step 2, we haven't created a request yet, so just go back.
        // But if we want to be consistent with "deleting the request" (conceptually the draft),
        // we just reset. Since no ID is generated yet, no backend call needed.
        resetToComposeState();
    });

    // --- Step 2 to Step 3 (Confirm & Pay) ---
    confirmSealButton.addEventListener('click', createMessageRequest);

    // --- Step 3 Cancel ---
    cancelStep3Button.addEventListener('click', cancelRequest);

    // --- Copy Address Button ---
    copyAddressButton.addEventListener('click', () => {
        const address = paymentAddressEl.textContent;
        if (address && address !== '...') {
            navigator.clipboard.writeText(address).then(() => {
                const originalText = copyAddressButton.textContent;
                copyAddressButton.textContent = '✅';
                setTimeout(() => {
                    copyAddressButton.textContent = originalText;
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy: ', err);
            });
        }
    });

    // --- New Message Button (from Success screen) ---
    createNewMessageButton.addEventListener('click', resetToComposeState);


    // --- Initial Page Load Logic ---
    function initialize() {
        // This function checks if there's an unfinished process from a previous session.
        const savedRequestId = localStorage.getItem('activeRequestId');
        if (savedRequestId) {
            console.log(`Found saved request ID: ${savedRequestId}`);
            currentRequestId = savedRequestId;
            // We don't have the message or payment info, so we go straight to the payment step
            // and let the status check fill in the details.
            transitionToStep('compose-step', 'payment-step');
            checkStatus(currentRequestId);
        } else {
            // Default state
            resetToComposeState();
        }
    }

    initialize();

});