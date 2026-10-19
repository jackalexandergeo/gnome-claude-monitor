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

// More changes than this at once (a long lock, a week away) become one summary banner.
export const MAX_NOTIFICATIONS_AT_ONCE = 4;
const NEEDS_YOU_PREFIX = 'Needs you: ';

const STATUS_LABELS = {
    'triaging': 'triaging',
    'new': 'new',
    'researching': 'researching',
    'needs-you': 'needs you',
    'in-review': 'in review',
    'mr-open': 'MR open',
    'proposed': 'proposed',
    'done': 'done',
    'failed': 'failed',
};

// A leading "-" would reach `claude attach` as an option (e.g. "--help"), so ids must
// start with a letter or digit.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

// The reviews a snapshot can say are waiting on the user's approve/reject, and what each
// answer does there.
const DECISION_LABELS = {
    research: ['Accept the research', 'Send it back'],
    ticket: ['File the ticket', "Don't file it"],
    change: ['Open the draft MR', 'Drop the change'],
};
// What each answer does, said in the confirmation before it is sent.
const DECISION_CONSEQUENCES = {
    research: ['The pipeline goes on with this research as it is.', "The research runs again with the reviewer's notes."],
    ticket: ['Files the ticket.', 'No ticket is filed for this issue.'],
    change: ['Pushes the branch and opens a draft MR.', 'The change is dropped; no MR is opened.'],
};

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
        // where to send decisions; only an absolute path is taken
        hubSocket: typeof state.hub?.socket === 'string' && state.hub.socket.startsWith('/') ? state.hub.socket : null,
        sources: parseSources(state.sources),
        counts: {
            today: Number(state.counts?.today) || 0,
            total: Number(state.counts?.total) || 0,
            open: Number(state.counts?.open) || 0,
            untriaged: Number(state.counts?.untriaged) || 0,
        },
        issues: Array.isArray(state.issues) ? state.issues.filter(isIssueLike).map(withName) : [],
        otherPings: Array.isArray(state.otherPings) ? state.otherPings.filter(isIssueLike).map(withName) : [],
    };
}

// What feeds the hub (a chat poller, a script) reports in; nothing heard for this long is a warning.
export const SOURCE_SILENT_AFTER_MS = 3 * 60 * 1000;

function parseSources(sources) {
    if (!sources || typeof sources !== 'object' || Array.isArray(sources))
        return {};
    const parsed = {};
    for (const [name, source] of Object.entries(sources)) {
        if (source && typeof source === 'object' && typeof source.ok === 'boolean')
            parsed[name] = { ok: source.ok, detail: String(source.detail ?? ''), at: Number(source.at) || 0 };
    }
    return parsed;
}

/** One line per source that is unhealthy or has gone quiet, worst news first. */
export function sourceWarnings(state, now) {
    const warnings = [];
    for (const [name, source] of Object.entries(state?.sources ?? {})) {
        if (!source.ok)
            warnings.push(`⚠ ${name}: ${source.detail || 'unhealthy'}`);
        else if (now - source.at > SOURCE_SILENT_AFTER_MS)
            warnings.push(`⚠ ${name}: no heartbeat for ${formatAgo(now - source.at).replace(' ago', '')}`);
    }
    return warnings;
}

function isIssueLike(issue) {
    return issue && typeof issue === 'object' && Number.isInteger(issue.id);
}

function withName(issue) {
    return typeof issue.name === 'string' && issue.name ? issue : { ...issue, name: '(untitled)' };
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
    const line = [...sourceWarnings(state, now), parts.join(' · ')].join('  ·  ');
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
    for (const gate of Array.isArray(issue.awaiting) ? issue.awaiting : []) {
        if (!Object.hasOwn(DECISION_LABELS, gate))
            continue;
        const [approveLabel, rejectLabel] = DECISION_LABELS[gate];
        const [approveConsequence, rejectConsequence] = DECISION_CONSEQUENCES[gate];
        actions.push({ kind: 'decision', label: approveLabel, gate, approve: true, consequence: approveConsequence });
        actions.push({ kind: 'decision', label: rejectLabel, gate, approve: false, consequence: rejectConsequence });
    }
    return actions;
}

/**
 * What to tell the user about, comparing two snapshots: issues that newly became real
 * issues, and issues that newly need the user. With no previous snapshot (the very first
 * start) nothing is announced. After a lock or login the previous snapshot is the one
 * remembered on disk, so only what changed meanwhile is announced.
 */
export function notificationsBetween(previous, next) {
    if (!previous || !next)
        return [];
    const before = new Map(previous.issues.map(issue => [issue.id, issue]));
    const notifications = [];
    for (const issue of next.issues) {
        const old = before.get(issue.id);
        // A new question on an issue that already needed the user is news too (a review can
        // drop below the bar while an earlier question is still open), but a question that
        // went away, or one remembered from before questions were kept, is not.
        const question = typeof issue.question === 'string' && issue.question ? issue.question : null;
        const newQuestion = question !== null && old?.question !== undefined && (old.question ?? null) !== question;
        if (needsYou(issue) && !(old && needsYou(old) && !newQuestion)) {
            // Pending until dismissed. `baseline` is remembered meanwhile (see announcedMap):
            // the status before, but this issue's kind, so that once it is answered it never
            // comes back as a "New issue" (the needs-you banner stood in for that one).
            notifications.push({
                title: `${NEEDS_YOU_PREFIX}${issue.name}`, body: question || issue.lastPing?.preview || '', url: issue.url,
                pending: [{
                    id: issue.id,
                    baseline: { status: old?.status ?? null, kind: issue.kind, question: old ? old.question ?? null : null },
                }],
            });
        } else if (issue.kind === 'issue' && !(old && old.kind === 'issue')) {
            const author = issue.lastPing?.author ? ` from @${issue.lastPing.author}` : '';
            notifications.push({ title: `New issue: ${issue.name}`, body: `Picked up${author}`, url: issue.url, pending: [] });
        }
    }
    return notifications;
}

/**
 * At most MAX_NOTIFICATIONS_AT_ONCE banners; the rest fold into one summary. "Needs you"
 * comes first, so a burst of new issues can never fold away the one that waits on you.
 */
export function limitNotifications(notifications) {
    if (notifications.length <= MAX_NOTIFICATIONS_AT_ONCE)
        return notifications;
    const ordered = [
        ...notifications.filter(notification => notification.title.startsWith(NEEDS_YOU_PREFIX)),
        ...notifications.filter(notification => !notification.title.startsWith(NEEDS_YOU_PREFIX)),
    ];
    notifications = ordered;
    const shown = notifications.slice(0, MAX_NOTIFICATIONS_AT_ONCE - 1);
    const folded = notifications.slice(shown.length);
    return [...shown, {
        title: `${folded.length} more issue updates`, body: 'Open the Issues menu to see them', url: null,
        pending: folded.flatMap(notification => notification.pending ?? []),
    }];
}

/**
 * The part of a snapshot worth remembering between sessions: each issue's status and kind.
 * An issue with a needs-you notification not yet dismissed (`pending`: id -> its baseline)
 * is remembered as that baseline, so if the shell clears the notification (it does on every
 * lock) and the issue still needs you, it is raised again; if it has moved on meanwhile,
 * nothing is. A New-issue banner is announced once and never pends.
 */
export function announcedMap(state, pending = new Map()) {
    const map = {};
    for (const issue of state?.issues ?? []) {
        if (!pending.has(issue.id))
            map[issue.id] = { status: issue.status, kind: issue.kind, question: typeof issue.question === 'string' ? issue.question : null };
        else
            map[issue.id] = pending.get(issue.id);
    }
    return map;
}

/** A remembered map back in snapshot shape, as the `previous` of notificationsBetween. */
export function stateFromAnnounced(map) {
    if (!map || typeof map !== 'object')
        return null;
    return {
        issues: Object.entries(map)
            .filter(([id, issue]) => Number.isInteger(Number(id)) && issue && typeof issue === 'object')
            // no "question" key: remembered before questions were kept, so unknown, not null
            .map(([id, issue]) => ({
                id: Number(id), status: issue.status, kind: issue.kind,
                question: Object.hasOwn(issue, 'question') ? issue.question : undefined,
            })),
    };
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
