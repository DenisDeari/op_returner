// frontend/js/app.js
document.addEventListener('DOMContentLoaded', () => {
    'use strict';

    const SERVICE_FEE = 2000;   // config.js SERVICE_FEE_SATS
    const RING_CIRC = 94.25;    // 2 * pi * r, r = 15
    let MAX_BYTES = 1000;

    // --- DOM ---------------------------------------------------------------
    const $ = (id) => document.getElementById(id);

    const msg = $('msg');
    const ring = $('ring'), ringN = $('ring-n');
    const publicToggle = $('public-toggle');
    const addrIn = $('addr-in'), amtIn = $('amt-in'), amtNote = $('amt-note');
    const feeIn = $('fee-in'), feeN = $('fee-n');
    const optBtn = $('opt-btn'), drawer = $('drawer');
    const totalBtn = $('total-btn'), totalN = $('total-n'), breakdown = $('breakdown');
    const bdNet = $('bd-net'), bdSvc = $('bd-svc'), bdRec = $('bd-rec');
    const go = $('go');
    const mine = $('mine'), ordersEl = $('orders');
    const wallEl = $('wall'), wallN = $('wall-n');
    const api = $('api'), apiLink = $('api-link');
    const live = $('live');
    const modal = $('modal'), modalX = $('modal-x'), copyBtn = $('copy-btn');
    const qrBox = $('qr-box'), qrImg = $('qr-img');
    const modalAmount = $('modal-amount'), modalAddress = $('modal-address');

    // --- State -------------------------------------------------------------
    // One key, unchanged from the previous build so orders already in flight in a
    // customer's browser survive this deploy. New fields are additive; an older entry
    // simply lacks them.
    const STORE = 'opr_orders';
    let orders = [];
    try { orders = JSON.parse(localStorage.getItem(STORE)) || []; } catch { orders = []; }
    const save = () => { try { localStorage.setItem(STORE, JSON.stringify(orders)); } catch { /* quota */ } };

    // --- Helpers -----------------------------------------------------------
    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        return String(text).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
    }

    const bytesOf = (s) => new TextEncoder().encode(s || '').length;
    const fmt = (n) => Number(n || 0).toLocaleString();

    function ago(iso) {
        const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
        if (!Number.isFinite(mins) || mins < 0) return 'just now';
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const h = Math.floor(mins / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    }

    // Size of the output paying `address`, mirroring backend/src/tx_sizing.js.
    //
    // CARRIED ACROSS VERBATIM — do not "simplify" the prefix tests. Collapsing bc1q and
    // bc1p into one branch under-quotes both P2WSH and P2TR by 12 vBytes and understates
    // their dust floor by 27 sats, which is precisely the arithmetic that cost four
    // customers refund fees on 2026-08-06. The bc1q length test must stay AFTER the bc1p
    // test, because a P2TR address is also 62 characters. Taproot is live now, so this is
    // a real path rather than the dead code it used to be.
    //
    // Recognised by prefix rather than by decoding — this only drives a preview, and the
    // server is the authority on what is actually charged.
    function recipientOutputVBytes(address) {
        const a = (address || '').trim().toLowerCase();
        if (a.startsWith('bc1p')) return 43;                      // P2TR
        if (a.startsWith('bc1q')) return a.length > 50 ? 43 : 31; // P2WSH : P2WPKH
        if (a.startsWith('3')) return 32;                         // P2SH
        if (a.startsWith('1')) return 34;                         // P2PKH
        return 43;                                                // unknown: quote the largest
    }

    // The dust limit for that output, again mirroring tx_sizing.js: 3 sat/vB against the
    // output plus an undiscounted 148-vByte spend, floored at the service-wide 546.
    function recipientDustLimit(address) {
        return Math.max(546, 3 * (recipientOutputVBytes(address) + 148));
    }

    // --- Live limits -------------------------------------------------------
    fetch('/api/config/limits')
        .then((r) => r.json())
        .then((d) => { if (d.maxPayloadSize) { MAX_BYTES = d.maxPayloadSize; recalc(); } })
        .catch(() => {});

    fetch('/api/health')
        .then((r) => { if (!r.ok) throw new Error(); })
        .catch(() => { live.classList.add('down'); live.lastChild.textContent = ' offline'; });

    // --- Cost --------------------------------------------------------------
    let shownTotal = 0, raf = null;
    function animateTotal(target) {
        if (raf) cancelAnimationFrame(raf);
        const from = shownTotal;
        let start = null;
        const step = (ts) => {
            if (start === null) start = ts;
            let k = Math.min(1, (ts - start) / 260);
            k = 1 - Math.pow(1 - k, 3);
            shownTotal = Math.round(from + (target - from) * k);
            totalN.textContent = fmt(shownTotal);
            if (k < 1) raf = requestAnimationFrame(step);
        };
        raf = requestAnimationFrame(step);
    }

    function recalc() {
        let bytes = bytesOf(msg.value);
        if (bytes > MAX_BYTES) {
            let cut = msg.value;
            while (bytesOf(cut) > MAX_BYTES) cut = cut.slice(0, -1);
            msg.value = cut;
            bytes = MAX_BYTES;
        }

        ringN.textContent = bytes >= 1000 ? `${Math.floor(bytes / 1000)}k` : bytes;
        ring.querySelector('.fill').style.strokeDashoffset = RING_CIRC - RING_CIRC * (bytes / MAX_BYTES);
        ring.className = bytes >= MAX_BYTES ? 'ring full' : 'ring';

        // Fall back rather than let a NaN through: fmt() would render it as "0", and a
        // quote reading "0 sats" is worse than a wrong one, because it looks deliberate.
        const fee = parseInt(feeIn.value, 10) || 2;
        feeN.textContent = fee;

        const recipient = addrIn.value.trim();
        let amount = parseInt(amtIn.value, 10) || 0;
        if (!recipient) amount = 0;

        // Mirrors queue.js: 10.5 overhead + 68 input + (11 + message) OP_RETURN + 31 change.
        let vb = 10.5 + 68 + (11 + bytes) + 31;
        if (recipient) vb += recipientOutputVBytes(recipient);
        vb = Math.ceil(vb);

        const network = vb * fee;
        bdNet.textContent = fmt(network);
        bdSvc.textContent = fmt(SERVICE_FEE);
        bdRec.textContent = fmt(amount);
        animateTotal(network + SERVICE_FEE + amount);

        // Say the minimum out loud, before any money moves. The server refuses a sub-dust
        // amount, but a customer who only finds that out after paying has learned it the
        // expensive way — which is exactly what happened on 2026-08-06.
        if (recipient) {
            const min = recipientDustLimit(recipient);
            amtIn.min = String(min);
            const tooSmall = amount > 0 && amount < min;
            amtNote.textContent = tooSmall
                ? `Below ${min} sats the network drops this output as dust.`
                : `0, or at least ${min} for this address.`;
            amtNote.className = tooSmall ? 'note warn' : 'note';
            amtIn.style.borderColor = tooSmall ? 'var(--red)' : '';
        } else {
            amtIn.min = '0';
            amtNote.textContent = 'Leave empty to just publish the message.';
            amtNote.className = 'note';
            amtIn.style.borderColor = '';
        }
    }

    // --- Order status ------------------------------------------------------
    // Every status the backend can produce. Nine are stored; `archived` is synthesised by
    // routes/api.js for a request it has retired.
    const FAILURE_STATUSES = ['op_return_failed', 'refund_failed', 'refund_processing', 'refunded'];
    const isFailure = (s) => FAILURE_STATUSES.includes(s);

    // Statuses where nothing further can change, so polling stops. `archived` belongs
    // here: the row is final, and without it the browser polls a dead request forever.
    const TERMINAL_STATUSES = ['op_return_broadcasted', 'refunded', 'refund_failed', 'archived'];

    // Five steps: Created, Paid, Confirmed, Published, In a block.
    //
    // Always returns five entries. An earlier version returned a shorter array for some
    // statuses and the renderer skipped the empty ones, which made an archived order draw
    // as a single dot pinned to the right with no track at all — the CSS sizes the last
    // step to its content and strips its connector.
    //
    // '' | 'done' | 'now' | 'bad'
    const RAIL_LABELS = ['Created', 'Paid', 'Confirmed', 'Published', 'In a block'];

    function railFor(order) {
        const s = order.status;
        const mined = !!order.opReturnConfirmedAt;

        switch (s) {
            case 'pending_payment':       return ['done', 'now', '', '', ''];
            case 'payment_detected':      return ['done', 'done', 'now', '', ''];
            // payment_confirmed and processing_op_return are the same thing to a customer:
            // the money is in and we are building. processing_op_return is a mutex, not a
            // stage, and reconcile flips it back after 30 minutes.
            case 'payment_confirmed':
            case 'processing_op_return':  return ['done', 'done', 'done', 'now', ''];
            case 'op_return_broadcasted': return ['done', 'done', 'done', 'done', mined ? 'done' : 'now'];
            case 'refunded':              return ['done', 'done', 'done', 'bad', ''];
            case 'refund_processing':
            case 'refund_failed':
            case 'op_return_failed':      return ['done', 'done', 'done', 'bad', ''];
            // Withdrawn. Usually it stops there — but an operator can still publish or
            // refund an archived order, so follow the evidence rather than the status.
            case 'archived':
                if (order.txId) return ['done', 'done', 'done', 'done', mined ? 'done' : 'now'];
                if (order.refundTxId) return ['done', 'done', 'done', 'bad', ''];
                return ['bad', '', '', '', ''];
            default:                      return ['done', 'now', '', '', ''];
        }
    }

    function labelFor(order) {
        switch (order.status) {
            case 'pending_payment':       return 'Awaiting payment';
            case 'payment_detected':      return 'Payment seen, waiting for a confirmation';
            case 'payment_confirmed':     return 'Paid — publishing';
            case 'processing_op_return':  return 'Publishing';
            case 'op_return_broadcasted':
                return order.opReturnConfirmedAt
                    ? 'In a block — permanent'
                    : 'Published. Waiting for a miner to include it, which can take a while at a low fee rate.';
            case 'op_return_failed':      return 'Could not publish';
            case 'refund_processing':     return 'Refunding';
            case 'refunded':              return 'Refunded';
            case 'refund_failed':         return 'Refund needs manual review';
            case 'archived':              return order.archivedReason === 'cancelled_by_customer' ? 'Cancelled' : 'Expired';
            default:                      return String(order.status || '').replace(/_/g, ' ');
        }
    }

    // --- Orders ------------------------------------------------------------
    const drafts = {};   // in-progress feedback text, kept out of the DOM across re-renders

    function addOrder(data) {
        if (orders.some((o) => o.requestId === data.requestId)) return;
        orders.unshift({ ...data, status: 'pending_payment', createdAt: new Date().toISOString() });
        save();
        renderOrders();
    }

    function removeOrder(id) {
        orders = orders.filter((o) => o.requestId !== id);
        save();
        renderOrders();
    }

    function applyStatus(id, data) {
        const order = orders.find((o) => o.requestId === id);
        if (!order) return;
        let changed = false;
        const set = (k, v) => {
            if (v !== undefined && v !== null && order[k] !== v) { order[k] = v; changed = true; }
        };
        set('status', data.status);
        set('txId', data.opReturnTxId);
        set('supportEmail', data.supportEmail);
        set('refundTxId', data.refundTxId);
        set('failureReason', data.failureReason);
        set('archivedReason', data.archivedReason);
        set('opReturnConfirmedAt', data.opReturnConfirmedAt);
        set('opReturnBlockHeight', data.opReturnBlockHeight);
        // The server explains a retired request in `error`. Keep it — the customer
        // otherwise sees a bare status and no reason.
        if (data.status === 'archived') set('archivedNote', data.error);
        if (data.userFeedback && !order.feedbackSent) { order.feedbackSent = true; changed = true; }
        if (changed) { save(); renderOrders(); }
    }

    function renderOrders() {
        mine.hidden = orders.length === 0;
        if (!orders.length) { ordersEl.innerHTML = ''; return; }

        // Remember where the cursor was — a poll re-renders every 5 seconds.
        const active = document.activeElement;
        const focusedId = active && active.classList && active.classList.contains('feedback-input')
            ? active.dataset.id : null;
        const caret = focusedId ? active.selectionStart : null;

        ordersEl.innerHTML = '';

        orders.forEach((order, i) => {
            const failed = isFailure(order.status);
            const done = order.status === 'op_return_broadcasted';
            const el = document.createElement('article');
            el.className = `order${failed ? ' is-failed' : ''}${done ? ' is-done' : ''}`;
            el.style.animationDelay = `${Math.min(i, 6) * 0.03}s`;

            const rail = railFor(order);
            const railLabels = (order.status === 'archived' && !order.txId && !order.refundTxId)
                ? ['Withdrawn', '', '', '', '']
                : RAIL_LABELS;

            // Feedback box: only once the request has actually failed, and only until sent.
            let feedbackHtml = '';
            if (failed) {
                feedbackHtml = order.feedbackSent
                    ? '<div class="feedback-sent">Your message was sent to the operator. Thank you.</div>'
                    : `<div class="feedback">
                         <label for="fb-${escapeHtml(order.requestId)}">Something went wrong. Leave a message for the operator:</label>
                         <textarea id="fb-${escapeHtml(order.requestId)}" class="feedback-input" data-id="${escapeHtml(order.requestId)}"
                                   maxlength="1000" placeholder="What happened, and how can we reach you?">${escapeHtml(drafts[order.requestId] || '')}</textarea>
                         <div class="feedback-row">
                           <button class="btn-s act-feedback" type="button" data-id="${escapeHtml(order.requestId)}">Send</button>
                           <span class="feedback-counter">0 / 1000</span>
                         </div>
                       </div>`;
            }

            el.innerHTML = `
                <div class="order-top">
                    <span>${escapeHtml(order.requestId.substring(0, 8))}</span>
                    <span>·</span>
                    <span>${escapeHtml(ago(order.createdAt))}</span>
                </div>
                <div class="order-msg">${escapeHtml(order.message)}${order.isPublic ? '<span class="tag">on the wall</span>' : ''}</div>
                ${/* ALWAYS five <li>. Skipping the unlabelled ones collapses the flex row
                      and the rail renders as one stray dot with no track — the last step
                      is sized to its content and has its connector removed by design. */ ''}
                <ol class="rail">
                    ${rail.map((c, n) => `<li class="${c}"><span>${escapeHtml(railLabels[n] || '')}</span></li>`).join('')}
                </ol>
                <div class="order-note" style="${order.status === 'pending_payment' || (done && order.opReturnConfirmedAt) ? 'display:none' : ''}">${escapeHtml(labelFor(order))}</div>
                ${order.archivedNote ? `<div class="order-note bad">${escapeHtml(order.archivedNote)}</div>` : ''}
                ${order.refundTxId ? `<div class="order-note good">Your payment was refunded — <a href="https://mempool.space/tx/${encodeURIComponent(order.refundTxId)}" target="_blank" rel="noopener">view transaction ↗</a></div>` : ''}
                ${failed && order.supportEmail ? `<div class="order-note">Need help? <a href="mailto:${escapeHtml(order.supportEmail)}?subject=SatWire%20request%20${encodeURIComponent(order.requestId)}">${escapeHtml(order.supportEmail)}</a></div>` : ''}
                ${feedbackHtml}
                <div class="order-foot">
                    ${/* An ALLOWLIST, and it must stay one. The server relies on it: reporting
                          'archived' removes the PAY button from an already-open tab with no
                          frontend deploy, and that only works because the button renders for
                          known-live statuses rather than "anything not terminal". Inverting it
                          gives a retired order a working PAY button pointing at a dead address,
                          because the amount and address come from localStorage. */ ''}
                    ${order.status === 'pending_payment' ? `<button class="btn-s primary act-pay" type="button" data-id="${escapeHtml(order.requestId)}">Pay ${fmt(order.requiredAmountSatoshis)} sats</button>` : ''}
                    ${order.txId ? `<a class="btn-s" href="https://mempool.space/tx/${encodeURIComponent(order.txId)}" target="_blank" rel="noopener">View on-chain ↗</a>` : ''}
                    <button class="btn-s act-drop" type="button" data-id="${escapeHtml(order.requestId)}">${(done || failed || order.status === 'archived') ? 'Remove' : 'Cancel'}</button>
                </div>`;

            ordersEl.appendChild(el);

            const fbInput = el.querySelector('.feedback-input');
            const fbCount = el.querySelector('.feedback-counter');
            if (fbInput && fbCount) {
                const sync = () => { fbCount.textContent = `${bytesOf(fbInput.value)} / 1000`; };
                sync();
                fbInput.addEventListener('input', () => { drafts[order.requestId] = fbInput.value; sync(); });
            }
        });

        if (focusedId) {
            const restored = ordersEl.querySelector(`.feedback-input[data-id="${CSS.escape(focusedId)}"]`);
            if (restored) {
                restored.focus();
                if (caret !== null) { try { restored.setSelectionRange(caret, caret); } catch { /* ignore */ } }
            }
        }
    }

    // One delegated listener rather than per-card bindings, so a re-render cannot leak them.
    ordersEl.addEventListener('click', (e) => {
        const pay = e.target.closest('.act-pay');
        const drop = e.target.closest('.act-drop');
        const fb = e.target.closest('.act-feedback');
        if (pay) openPayment(orders.find((o) => o.requestId === pay.dataset.id));
        if (drop) dropOrder(drop.dataset.id);
        if (fb) sendFeedback(fb.dataset.id, fb);
    });

    // --- API ---------------------------------------------------------------
    async function broadcast() {
        if (!bytesOf(msg.value)) { msg.focus(); return; }

        go.disabled = true;
        const label = go.innerHTML;
        go.textContent = 'Working…';

        try {
            const res = await fetch('/api/message-request', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: msg.value,
                    targetAddress: addrIn.value.trim() || undefined,
                    feeRate: parseInt(feeIn.value, 10),
                    amountToSend: parseInt(amtIn.value, 10) || 0,
                    isPublic: !!publicToggle.checked,
                }),
            });
            const data = await res.json();

            if (res.ok) {
                addOrder({
                    requestId: data.requestId,
                    address: data.address,
                    requiredAmountSatoshis: data.requiredAmountSatoshis,
                    // What the SERVER recorded, not what we asked for.
                    isPublic: !!data.isPublic,
                    message: msg.value,
                });
                msg.value = '';
                recalc();
                const fresh = orders[0];
                if (fresh) openPayment(fresh);
            } else {
                // Covers the 429 from intake throttling, whose body explains the limit.
                alert(data.error || 'Something went wrong. Please try again.');
            }
        } catch {
            alert('Network error. Check your connection and try again.');
        } finally {
            go.disabled = false;
            go.innerHTML = label;
        }
    }

    async function dropOrder(id) {
        const order = orders.find((o) => o.requestId === id);
        if (!order) return;
        const settled = order.status !== 'pending_payment' && order.status !== 'payment_detected';
        if (settled) { removeOrder(id); return; }
        if (!confirm('Cancel this request?')) return;
        try {
            const res = await fetch(`/api/request/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (res.ok || res.status === 404) { removeOrder(id); return; }
            const data = await res.json();
            alert(data.error || 'Could not cancel this request.');
        } catch {
            alert('Network error.');
        }
    }

    async function sendFeedback(id, button) {
        const box = ordersEl.querySelector(`.feedback-input[data-id="${CSS.escape(id)}"]`);
        const text = (box && box.value.trim()) || '';
        if (!text) { if (box) box.focus(); return; }

        button.disabled = true;
        button.textContent = 'Sending…';
        try {
            const res = await fetch(`/api/request/${encodeURIComponent(id)}/feedback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: text }),
            });
            const data = await res.json();
            if (res.ok) {
                const order = orders.find((o) => o.requestId === id);
                if (order) { order.feedbackSent = true; delete drafts[id]; save(); renderOrders(); }
            } else {
                alert(data.error || 'Could not send that.');
                button.disabled = false;
                button.textContent = 'Send';
            }
        } catch {
            alert('Network error. Please try again.');
            button.disabled = false;
            button.textContent = 'Send';
        }
    }

    // A broadcast order is no longer finished the moment it broadcasts — it still has to
    // reach a block, and the server learns that separately. So it stays pollable until
    // it does, but on a much slower cadence: a confirmation takes ~10 minutes at best,
    // and at the 2 sat/vB floor it can take days. Polling that every 5 seconds would be
    // thousands of pointless requests per order.
    const CONFIRM_POLL_MS = 60 * 1000;
    const lastConfirmPoll = {};

    function needsPolling(order) {
        if (!TERMINAL_STATUSES.includes(order.status)) return true;
        if (order.status !== 'op_return_broadcasted' || order.opReturnConfirmedAt) return false;
        // Stamped BEFORE the request, not after: a slow or failed fetch would otherwise
        // leave the mark unset and the order would fire again on every single tick.
        const now = Date.now();
        if (now - (lastConfirmPoll[order.requestId] || 0) < CONFIRM_POLL_MS) return false;
        lastConfirmPoll[order.requestId] = now;
        return true;
    }

    // poll() awaits one request per order in sequence, while setInterval fires regardless.
    // Without this guard a slow connection stacks overlapping passes on top of each other,
    // each one re-requesting everything. Pre-existing; it only gets worse as the polled
    // set grows.
    let polling = false;

    async function poll() {
        if (polling || !orders.length) return;
        if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') return;
        polling = true;
        try {
            for (const order of [...orders]) {
                if (!needsPolling(order)) continue;
                try {
                    const res = await fetch(`/api/request-status/${encodeURIComponent(order.requestId)}`);
                    if (!res.ok) continue;
                    applyStatus(order.requestId, await res.json());
                } catch { /* silent — the next tick tries again */ }
            }
        } finally {
            polling = false;
        }
    }

    // --- The wall ----------------------------------------------------------
    async function loadWall() {
        try {
            const res = await fetch('/api/wall');
            if (!res.ok) throw new Error('wall');
            const data = await res.json();
            renderWall(data.messages || []);
        } catch {
            wallEl.innerHTML = '';
            const p = document.createElement('p');
            p.className = 'wall-empty';
            p.textContent = 'Could not load the wall just now.';
            wallEl.appendChild(p);
        }
    }

    function renderWall(messages) {
        wallEl.innerHTML = '';
        wallN.textContent = messages.length ? `${fmt(messages.length)} published` : '';

        if (!messages.length) {
            const p = document.createElement('p');
            p.className = 'wall-empty';
            p.textContent = 'Nothing here yet. Yours could be first.';
            wallEl.appendChild(p);
            return;
        }

        messages.forEach((m, i) => {
            const card = document.createElement('article');
            card.className = 'note-card';
            card.style.animationDelay = `${Math.min(i, 12) * 0.04}s`;

            // textContent, not innerHTML. This is text written by strangers, rendered on
            // the same origin that serves /admin. The escaper would very probably be
            // enough; not depending on it is cheaper than being sure.
            const p = document.createElement('p');
            p.textContent = m.message;

            const foot = document.createElement('footer');
            const when = document.createElement('span');
            when.textContent = m.publishedAt ? ago(m.publishedAt) : '';
            foot.appendChild(when);

            if (m.opReturnTxId) {
                const link = document.createElement('a');
                link.href = `https://mempool.space/tx/${encodeURIComponent(m.opReturnTxId)}`;
                link.target = '_blank';
                link.rel = 'noopener';
                link.textContent = 'tx ↗';
                foot.appendChild(link);
            }

            card.appendChild(p);
            card.appendChild(foot);
            wallEl.appendChild(card);
        });
    }

    // --- Payment modal -----------------------------------------------------
    function openPayment(order) {
        if (!order) return;
        modalAmount.textContent = fmt(order.requiredAmountSatoshis);
        modalAddress.textContent = order.address;

        qrBox.className = 'qr';
        qrImg.style.display = '';
        qrImg.src = `/api/payment-qr.svg?requestId=${encodeURIComponent(order.requestId)}`;
        qrImg.onerror = () => {
            // 410 once the order is archived or its webhooks are retired, 409 once it is
            // no longer awaiting payment. The address below stays readable either way.
            qrImg.style.display = 'none';
            qrBox.className = 'qr failed';
            qrBox.textContent = 'This request is no longer open for payment.';
        };

        modal.hidden = false;
    }
    const closePayment = () => { modal.hidden = true; };

    // --- Disclosures -------------------------------------------------------
    optBtn.addEventListener('click', () => {
        optBtn.setAttribute('aria-expanded', drawer.classList.toggle('open') ? 'true' : 'false');
    });

    const toggleBreakdown = () => {
        totalBtn.setAttribute('aria-expanded', breakdown.classList.toggle('open') ? 'true' : 'false');
    };
    totalBtn.addEventListener('click', toggleBreakdown);
    totalBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleBreakdown(); }
    });

    function openApiIfHashed() {
        if (location.hash === '#api') {
            api.open = true;
            api.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }
    apiLink.addEventListener('click', () => setTimeout(openApiIfHashed, 0));
    window.addEventListener('hashchange', openApiIfHashed);

    // --- Wiring ------------------------------------------------------------
    [msg, addrIn, amtIn, feeIn].forEach((el) => {
        el.addEventListener('input', recalc);
        el.addEventListener('change', recalc);
    });
    go.addEventListener('click', broadcast);

    modalX.addEventListener('click', closePayment);
    modal.addEventListener('click', (e) => { if (e.target === modal) closePayment(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePayment(); });

    copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(modalAddress.textContent).then(() => {
            copyBtn.textContent = 'Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1800);
        }).catch(() => {});
    });

    // --- Init --------------------------------------------------------------
    recalc();
    renderOrders();
    loadWall();
    openApiIfHashed();
    poll();
    setInterval(poll, 5000);
    setInterval(loadWall, 60000);
});
