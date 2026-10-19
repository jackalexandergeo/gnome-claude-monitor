/* pings.js — pure logic for the pingwatch Issues section (unit-tested, no Shell imports).
 *
 * pingwatch, a separate local service, turns chat pings into tracked issues and writes a
 * snapshot to $XDG_STATE_HOME/pingwatch/state.json. Without that file the whole feature
 * stays hidden. Everything here works on the parsed snapshot; file I/O is in pingService.js.
 */

export const SUPPORTED_STATE_VERSION = 1;

// The hub rewrites state.json on every change and at least once a minute; older than
// this and the hub is treated as not running.
export const STALE_AFTER_MS = 3 * 60 * 1000;

export const NEEDS_YOU_STATUSES = new Set(['needs-you']);

const STATUS_LABELS = {
    'triaging': 'triaging',
    'new': 'new',
    'researching': 'researching',
    'needs-you': 'needs you',
    'in-review': 'in review',
    'mr-open': 'MR open',
    'done': 'done',
    'failed': 'failed',
};

// A leading "-" would reach `claude attach` as an option (e.g. "--help"), so ids must
// start with a letter or digit.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** Parse state.json text. Returns null when it is missing, malformed or a newer format. */
export function parseState(text) {
    if (!text)
        return null;
    let state;
    try {
        state = JSON.parse(text);
    } catch (_error) {
        return null;
    }
    if (!state || typeof state !== 'object' || state.version !== SUPPORTED_STATE_VERSION)
        return null;
    return {
        updatedAt: Number(state.updatedAt) || 0,
        counts: {
            today: Number(state.counts?.today) || 0,
            total: Number(state.counts?.total) || 0,
            open: Number(state.counts?.open) || 0,
            untriaged: Number(state.counts?.untriaged) || 0,
        },
        issues: Array.isArray(state.issues) ? state.issues.filter(isIssueLike) : [],
        otherPings: Array.isArray(state.otherPings) ? state.otherPings.filter(isIssueLike) : [],
    };
}

function isIssueLike(issue) {
    return issue && typeof issue === 'object' && Number.isInteger(issue.id);
}

export function isStale(state, now) {
    return !state || now - state.updatedAt > STALE_AFTER_MS;
}

export function needsYou(issue) {
    return NEEDS_YOU_STATUSES.has(issue.status);
}

export function needsYouCount(state) {
    return state ? state.issues.filter(needsYou).length : 0;
}

export function statusLabel(status) {
    return STATUS_LABELS[status] || status || '?';
}

/** Collapsed panel text and its emphasis: 'alert' (needs you), 'active' (open issues), 'idle'. */
export function panelSummary(state, now) {
    const waiting = needsYouCount(state);
    // A silent hub must not hide that an agent was last seen waiting on you.
    if (isStale(state, now))
        return waiting > 0 ? { text: '–!', emphasis: 'alert' } : { text: '–', emphasis: 'idle' };
    const open = state.counts.open;
    if (waiting > 0)
        return { text: `${open}!`, emphasis: 'alert' };
    return { text: String(open), emphasis: open > 0 ? 'active' : 'idle' };
}

export function headerLine(state, now) {
    if (!state)
        return 'pingwatch is not running';
    const parts = [
        `Picked up today: ${state.counts.today}`,
        `total: ${state.counts.total}`,
        `need you: ${needsYouCount(state)}`,
    ];
    if (state.counts.untriaged > 0)
        parts.push(`untriaged: ${state.counts.untriaged}`);
    const line = parts.join(' · ');
    return isStale(state, now) ? `⚠ hub not responding · ${line}` : line;
}

function isWebURL(url) {
    return typeof url === 'string' && /^https?:\/\//.test(url);
}

/**
 * The dropdown actions for one issue, in display order. Each is
 * {kind: 'url', label, url} or {kind: 'session', label, sessionId}.
 * Anything malformed is dropped rather than shown as a broken action.
 */
export function issueActions(issue) {
    const actions = [];
    if (isWebURL(issue.url))
        actions.push({ kind: 'url', label: `Thread (${issue.source || 'source'})`, url: issue.url });
    const links = issue.links || {};
    const ticket = links.ticket;
    if (ticket && isWebURL(ticket.url))
        actions.push({ kind: 'url', label: `Ticket ${ticket.reference || ''}`.trim(), url: ticket.url });
    for (const mergeRequest of Array.isArray(links.mergeRequests) ? links.mergeRequests : []) {
        if (mergeRequest && isWebURL(mergeRequest.url))
            actions.push({ kind: 'url', label: `MR ${mergeRequest.reference || ''}`.trim(), url: mergeRequest.url });
    }
    for (const session of Array.isArray(links.sessions) ? links.sessions : []) {
        if (session && SESSION_ID_PATTERN.test(session.sessionId || ''))
            actions.push({ kind: 'session', label: `Agent: ${session.role || 'session'}`, sessionId: session.sessionId });
    }
    return actions;
}

/**
 * What to tell the user about, comparing two snapshots: issues that newly became real
 * issues, and issues that newly need the user. With no previous snapshot (login, or the
 * extension just enabled) nothing is announced, so a restart never replays old news.
 */
export function notificationsBetween(previous, next) {
    if (!previous || !next)
        return [];
    const before = new Map(previous.issues.map(issue => [issue.id, issue]));
    const notifications = [];
    for (const issue of next.issues) {
        const old = before.get(issue.id);
        if (needsYou(issue) && !(old && needsYou(old))) {
            notifications.push({ title: `Needs you: ${issue.name}`, body: issue.lastPing?.preview || '', url: issue.url });
        } else if (issue.kind === 'issue' && !(old && old.kind === 'issue')) {
            const author = issue.lastPing?.author ? ` from @${issue.lastPing.author}` : '';
            notifications.push({ title: `New issue: ${issue.name}`, body: `Picked up${author}`, url: issue.url });
        }
    }
    return notifications;
}

export function formatAgo(deltaMs) {
    if (deltaMs < 60_000)
        return 'just now';
    const minutes = Math.floor(deltaMs / 60_000);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
