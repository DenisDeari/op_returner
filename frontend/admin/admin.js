// frontend/admin/admin.js
document.addEventListener('DOMContentLoaded', () => {
    const requestsBody = document.getElementById('requests-body');
    const modal = document.getElementById('detail-modal');
    const modalBody = document.getElementById('modal-body');
    const closeButton = document.querySelector('.close-button');
    const refreshButton = document.getElementById('refresh-button');
    const API_BASE_URL = '/api/admin';
    let adminPassword = null;
    let allRequests = []; // Store requests locally

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
                requestsBody.innerHTML = `<tr><td colspan="6">Password is required to view requests.</td></tr>`;
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
            allRequests = requests; // Store for detail view
            renderRequests(requests); // Call the function to display the data
        } catch (error) {
            requestsBody.innerHTML = `<tr><td colspan="6">Error loading requests: ${error.message}</td></tr>`;
        }
    }

    function renderRequests(requests) {
        if (!requests || requests.length === 0) {
            requestsBody.innerHTML = '<tr><td colspan="6">No requests found in the database.</td></tr>';
            return;
        }

        requestsBody.innerHTML = requests.map(req => `
            <tr>
                <td>${req.id.substring(0, 8)}...</td>
                <td>${new Date(req.createdAt).toLocaleString()}</td>
                <td>${req.message}</td>
                <td><span class="status status-${req.status}">${req.status.replace(/_/g, ' ')}</span></td>
                <td>${req.opReturnTxId ? `<a href="https://mempool.space/tx/${req.opReturnTxId}" target="_blank">${req.opReturnTxId.substring(0, 10)}...</a>` : 'N/A'}</td>
                <td>
                    <button class="button-details" data-id="${req.id}" style="background-color: #5bc0de; margin-right: 5px;">Details</button>
                    ${(req.status === 'payment_confirmed' || req.status === 'op_return_failed') ? 
                    `<button class="button-fulfill" data-id="${req.id}">Manually Fulfill</button>` : ''}
                    <button class="button-delete" data-id="${req.id}" style="background-color: #d9534f; margin-left: 5px;">Delete</button>
                </td>
            </tr>
        `).join('');
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
                                <strong>TXID:</strong> <a href="https://mempool.space/tx/${tx.hash}" target="_blank">${tx.hash.substring(0, 20)}...</a><br>
                                <strong>Amount:</strong> ${tx.total} sats<br>
                                <strong>Confirmations:</strong> ${tx.confirmations}<br>
                                <strong>Time:</strong> ${tx.confirmed ? new Date(tx.confirmed).toLocaleString() : 'Unconfirmed'}
                            </li>
                        `).join('')}
                    </ul>`;
                } else {
                    txHistoryHtml = '<p>No transactions found for this address.</p>';
                }
            } else {
                txHistoryHtml = `<p style="color: red;">Error fetching transactions: ${response.statusText}</p>`;
            }

            modalBody.innerHTML = `
                <div class="detail-section">
                    <h3>General Info</h3>
                    <p><strong>ID:</strong> ${req.id}</p>
                    <p><strong>Status:</strong> ${req.status}</p>
                    <p><strong>Created At:</strong> ${new Date(req.createdAt).toLocaleString()}</p>
                    <p><strong>Message:</strong> ${req.message}</p>
                </div>
                <div class="detail-section">
                    <h3>Payment Info</h3>
                    <p><strong>Address:</strong> ${req.address}</p>
                    <p><strong>Required Amount:</strong> ${req.requiredAmountSatoshis} sats</p>
                    <p><strong>Refund Address:</strong> ${req.refundAddress || 'N/A'}</p>
                </div>
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
        const deleteButton = event.target.closest('.button-delete');

        if (detailsButton) {
            showDetails(detailsButton.dataset.id);
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

    // --- Hall of Fame Logic ---
    const hofBody = document.getElementById('hof-body');
    const refreshHofButton = document.getElementById('refresh-hof-button');
    const addHofBtn = document.getElementById('add-hof-btn');
    const hofMessageInput = document.getElementById('hof-message');
    const hofTxIdInput = document.getElementById('hof-txid');
    const hofDescInput = document.getElementById('hof-desc');

    if (refreshHofButton) {
        refreshHofButton.addEventListener('click', fetchHallOfFame);
    }

    if (addHofBtn) {
        addHofBtn.addEventListener('click', async () => {
            const message = hofMessageInput.value;
            const txId = hofTxIdInput.value;
            const description = hofDescInput.value;

            // Allow empty message if TXID is present (auto-fetch)
            if (!txId && !message) {
                alert('Either Message or TxID is required');
                return;
            }
            if (txId && !message) {
                // Optional: Notify user we are fetching
                addHofBtn.textContent = "Fetching...";
                addHofBtn.disabled = true;
            }

            try {
                const response = await fetch('/api/hall-of-fame', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ message, txId, description })
                });

                if (response.ok) {
                    const data = await response.json();
                    alert(data.autoFetched ? `Success! Fetched: "${data.message}"` : 'Added to Hall of Fame!');
                    hofMessageInput.value = '';
                    hofTxIdInput.value = '';
                    hofDescInput.value = '';
                    fetchHallOfFame();
                } else {
                    const err = await response.json();
                    alert('Error: ' + err.error);
                }
            } catch (e) {
                alert('Error: ' + e.message);
            } finally {
                addHofBtn.textContent = "Add to Hall of Fame";
                addHofBtn.disabled = false;
            }
        });
    }

    async function fetchHallOfFame() {
        try {
            const response = await fetch('/api/hall-of-fame');
            const data = await response.json();
            renderHallOfFame(data);
        } catch (e) {
            console.error(e);
            hofBody.innerHTML = '<tr><td colspan="5">Error loading Hall of Fame</td></tr>';
        }
    }

    function renderHallOfFame(items) {
        if (!items || items.length === 0) {
            hofBody.innerHTML = '<tr><td colspan="5">No entries found.</td></tr>';
            return;
        }
        hofBody.innerHTML = items.map(item => `
            <tr>
                <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.id}</td>
                <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.message}</td>
                <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.description || ''}</td>
                <td style="padding: 10px; border-bottom: 1px solid #eee;"><a href="https://mempool.space/tx/${item.txId}" target="_blank">${item.txId.substring(0, 10)}...</a></td>
                <td style="padding: 10px; border-bottom: 1px solid #eee;">
                    <button class="delete-hof-btn" data-id="${item.id}" style="background-color: #d9534f; color: white; border: none; padding: 5px 10px; cursor: pointer; border-radius: 3px;">Delete</button>
                </td>
            </tr>
        `).join('');

        document.querySelectorAll('.delete-hof-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                if (!confirm('Are you sure?')) return;
                const id = e.target.dataset.id;
                try {
                    const res = await fetch(`/api/hall-of-fame/${id}`, {
                        method: 'DELETE'
                    });
                    if (res.ok) {
                        fetchHallOfFame();
                    } else {
                        alert('Failed to delete');
                    }
                } catch (err) {
                    alert('Error deleting');
                }
            });
        });
    }

    // Initial load of HoF
    fetchHallOfFame();
});