// backend/src/event_log.js
//
// Keeps the most recent warnings and errors in memory so the admin panel can show them
// without anyone having to SSH in and read container logs.
//
// This is a convenience view, NOT the source of truth. It is deliberately in-memory and
// therefore lost on restart. Anything that actually matters — a request holding customer
// funds — is derived from the database in alerts.js, so a restart can never hide it.

const MAX_EVENTS = 300;

const events = [];
let installed = false;
let nextId = 1;

function record(level, message) {
    events.push({
        id: nextId++,
        at: new Date().toISOString(),
        level,
        message: String(message).slice(0, 2000),
    });
    if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
    }
}

/**
 * Mirrors console.warn/console.error into the buffer while leaving normal logging intact.
 * Called once at startup.
 */
function install() {
    if (installed) return;
    installed = true;

    const originalWarn = console.warn;
    const originalError = console.error;

    console.warn = (...args) => {
        originalWarn.apply(console, args);
        try {
            record('warn', args.map(formatArg).join(' '));
        } catch { /* logging must never break the caller */ }
    };

    console.error = (...args) => {
        originalError.apply(console, args);
        try {
            record('error', args.map(formatArg).join(' '));
        } catch { /* logging must never break the caller */ }
    };
}

function formatArg(a) {
    if (a instanceof Error) return `${a.message}`;
    if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return '[object]'; }
    }
    return String(a);
}

/** Most recent events first. */
function getEvents(limit = 100) {
    return events.slice(-limit).reverse();
}

function clear() {
    events.length = 0;
}

module.exports = { install, record, getEvents, clear, MAX_EVENTS };
