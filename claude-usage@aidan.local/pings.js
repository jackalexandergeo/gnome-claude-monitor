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

// What a notification is about sets its look: an emoji leading the title (it shows wherever
// the banner does, the lock screen's list included), an icon, and whether it is urgent.
export const NOTIFICATION_KINDS = {
    'needs-you': { emoji: '❗', label: 'Needs you', icon: 'dialog-warning-symbolic', urgent: true },
    'your-turn': { emoji: '👀', label: 'Your turn', icon: 'emblem-default-symbolic', urgent: false },
    'new': { emoji: '🆕', label: 'New issue', icon: 'mail-unread-symbolic', urgent: false },
    'renamed': { emoji: '✏️', label: 'Renamed', icon: 'document-edit-symbolic', urgent: false },
    'summary': { emoji: '📬', label: null, icon: 'view-list-symbolic', urgent: false },
    'problem': { emoji: '⚠️', label: null, icon: 'dialog-error-symbolic', urgent: false },
};

/** A notification's title: its kind's emoji and label, then the text. */
export function notificationTitle(kind, text) {
    const look = NOTIFICATION_KINDS[kind];
    return look.label ? `${look.emoji} ${look.label}: ${text}` : `${look.emoji} ${text}`;
}

const STATUS_LABELS = {
    'triaging': 'triaging',
    'new': 'new',
    'researching': 'researching',
    'needs-you': 'needs you',
    'in-review': 'in review',
    'mr-open': 'MR open',
    'mr-reviewed': 'MR reviewed: your turn',
    'awaiting-review': 'awaits review',
    'proposed': 'proposed',
    'done': 'done',
    'theirs': "someone else's",
    'wont-do': "won't do",
    'failed': 'failed',
};

// A leading "-" would reach `claude attach` as an option (e.g. "--help"), so ids must
// start with a letter or digit.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

// The reviews a snapshot can say are waiting on the user's approve/reject, and what each
// answer does there.
const DECISION_LABELS = {
    scope: ['Start anyway', 'Leave it to them'],
    research: ['Accept the research', 'Send it back'],
    ticket: ['File the ticket', "Don't file it"],
    change: ['Open the draft MR', 'Drop the change'],
    review: ['Take the MR as it is', 'Have it fixed'],
};
// Closing an issue as out of scope, from its menu: said in the confirmation first.
const CLOSED_STATUSES = new Set(['done', 'theirs', 'wont-do', 'ignored']);
const WONT_DO_CONSEQUENCE = 'The issue is closed as out of scope and its agent stops. A new ping on the thread brings it back.';

// What each answer does, said in the confirmation before it is sent.
const DECISION_CONSEQUENCES = {
    scope: ['The agents start working on this issue.', "Nothing more runs; the issue is marked as someone else's."],
    research: ['The pipeline goes on with this research as it is.', "The research runs again with the reviewer's notes."],
    ticket: ['Files the ticket.', 'No ticket is filed for this issue.'],
    change: ['Pushes the branch and opens a draft MR.', 'The change is dropped; no MR is opened.'],
    review: ['The MR is yours to review as it is.', "The agent fixes the review's findings on the same branch, then reviews the MR again."],
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

const SOURCE_DETAIL_CHARACTERS = 80;
const SOURCE_WARNINGS_SHOWN = 2;

/** Short lines for sources that are unhealthy (first) or have gone quiet, then "+N more". */
export function sourceWarnings(state, now) {
    const unhealthy = [];
    const silent = [];
    for (const [name, source] of Object.entries(state?.sources ?? {})) {
        if (!source.ok) {
            unhealthy.push(`⚠ ${name}: ${truncate(source.detail || 'unhealthy', SOURCE_DETAIL_CHARACTERS)}`);
        } else if (!source.at) {
            silent.push(`⚠ ${name}: no heartbeat yet`);
        } else if (now - source.at > SOURCE_SILENT_AFTER_MS) {
            silent.push(`⚠ ${name}: no heartbeat for ${formatAgo(now - source.at).replace(' ago', '')}`);
        }
    }
    const warnings = [...unhealthy, ...silent];
    if (warnings.length <= SOURCE_WARNINGS_SHOWN)
        return warnings;
    return [...warnings.slice(0, SOURCE_WARNINGS_SHOWN), `+${warnings.length - SOURCE_WARNINGS_SHOWN} more`];
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

// Board columns whose issues lead the list: where an agent is writing code.
export const FOCUS_COLUMNS = ['Clauding', 'Coding', 'In development', 'Development'];

/** Each issue's column on the board, by issue id, from pingwatch's board sync (items.json). */
export function boardColumns(text) {
    try {
        const posted = JSON.parse(text)?.posted || {};
        return new Map(Object.entries(posted)
            .filter(([, entry]) => typeof entry?.column === 'string')
            .map(([id, entry]) => [Number(id), entry.column]));
    } catch {
        return new Map();
    }
}

/** The issues with their board column; those in a focus column first, the rest in the hub's order. */
export function focusFirst(issues, columns) {
    const placed = issues.map(issue => {
        const boardColumn = columns.get(issue.id) ?? null;
        return { ...issue, boardColumn, focus: FOCUS_COLUMNS.includes(boardColumn) };
    });
    return [...placed.filter(issue => issue.focus), ...placed.filter(issue => !issue.focus)];
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
    const ofLimit = agentsOfLimit(state);
    if (ofLimit)
        parts.push(`agents ≈ ${ofLimit}% of the 5-hour limit`);
    const line = [...sourceWarnings(state, now), parts.join(' · ')].join('  ·  ');
    return isStale(state, now) ? `⚠ hub not responding · ${line}` : line;
}

/**
 * One issue's agents' share of Claude use, for its menu: "Usage: 2.2% of Claude use this 5 h
 * (≈ 1.3% of the limit) · 0.3% of Claude use this week", or null until the hub has worked it out.
 */
export function usageLine(usage) {
    if (!usage || typeof usage !== 'object')
        return null;
    const parts = [];
    for (const [key, window] of [['fiveHour', 'this 5 h'], ['week', 'this week']]) {
        const shown = usage[key];
        if (!shown || typeof shown.share !== 'number')
            continue;
        const limit = typeof shown.ofLimit === 'number' ? ` (≈ ${shown.ofLimit}% of the limit)` : '';
        parts.push(`${shown.share}% of Claude use ${window}${limit}`);
    }
    return parts.length ? `Usage: ${parts.join(' · ')}` : null;
}

/** Every issue's agents together: ≈ % of the 5-hour limit, or null when not known. */
export function agentsOfLimit(state) {
    const shares = (state?.issues ?? []).map(issue => issue.usage?.fiveHour?.ofLimit)
        .filter(value => typeof value === 'number');
    return shares.length ? Math.round(shares.reduce((sum, value) => sum + value, 0) * 10) / 10 : null;
}

function isWebURL(url) {
    return typeof url === 'string' && /^https?:\/\//.test(url);
}

/**
 * The dropdown actions for one issue, in display order. Each is
 * {kind: 'url', label, url} or {kind: 'session', label, sessionId}.
 * Anything malformed is dropped rather than shown as a broken action.
 */
// Other pings the user can still put agents on: a question gets answered, a review request reviewed.
const STARTABLE_KINDS = new Set(['question', 'review-request']);

/** Whether the user can start agents on it: a new issue not started yet, or a question or review request. */
export function canStart(issue) {
    if (issue.status === 'new')
        return !issue.links?.startRequested;
    return issue.status === 'ignored' && STARTABLE_KINDS.has(issue.kind);
}

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
    if (issue.onBoard === true)
        actions.push({ kind: 'board', label: 'Open on the board' });
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
    if (canStart(issue))
        actions.push({ kind: 'start', label: '▶ Start agents' });
    if (!CLOSED_STATUSES.has(issue.status))
        actions.push({ kind: 'close', label: "Won't do", consequence: WONT_DO_CONSEQUENCE });
    return actions;
}

/**
 * What to tell the user about, comparing two snapshots: issues that newly became real
 * issues, and issues that newly need the user. With no previous snapshot (the very first
 * start) nothing is announced. After a lock or login the previous snapshot is the one
 * remembered on disk, so only what changed meanwhile is announced.
 */
/** The issue's newest rename ({from, to, why}), or null. */
export function lastRename(issue) {
    const renamed = issue?.links?.renamed;
    const last = Array.isArray(renamed) ? renamed[renamed.length - 1] : null;
    return last && typeof last.from === 'string' && last.from ? last : null;
}

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
                kind: 'needs-you', title: notificationTitle('needs-you', issue.name),
                body: question || issue.lastPing?.preview || '', url: issue.url,
                pending: [{
                    id: issue.id,
                    baseline: { status: old?.status ?? null, kind: issue.kind, question: old ? old.question ?? null : null },
                }],
            });
        } else if (issue.kind === 'issue' && !(old && old.kind === 'issue')) {
            const author = issue.lastPing?.author ? `@${issue.lastPing.author}` : null;
            const preview = issue.lastPing?.preview || '';
            notifications.push({ kind: 'new', title: notificationTitle('new', issue.name),
                body: author ? (preview ? `${author}: ${preview}` : `Picked up from ${author}`) : preview || 'Picked up',
                url: issue.url, pending: [] });
        } else if (old && old.status !== 'mr-reviewed' && issue.status === 'mr-reviewed') {
            // The agents are done with the MR: it waits on the user's own review now.
            const mergeRequest = (issue.links?.mergeRequests ?? []).find(item => item?.url);
            notifications.push({ kind: 'your-turn', title: notificationTitle('your-turn', issue.name),
                body: `The agents reviewed ${mergeRequest?.reference || 'the MR'}: it is ready for yours`,
                url: mergeRequest?.url || issue.url, pending: [] });
        } else if (old && old.kind === 'issue' && old.name !== issue.name && lastRename(issue)) {
            // The agents found out what it is: say so, or the user no longer knows which issue it is.
            const rename = lastRename(issue);
            notifications.push({ kind: 'renamed', title: notificationTitle('renamed', issue.name),
                body: `Was: ${old.name} (${rename.why || 'renamed'})`, url: issue.url, pending: [] });
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
        ...notifications.filter(notification => notification.kind === 'needs-you'),
        ...notifications.filter(notification => notification.kind !== 'needs-you'),
    ];
    notifications = ordered;
    const shown = notifications.slice(0, MAX_NOTIFICATIONS_AT_ONCE - 1);
    const folded = notifications.slice(shown.length);
    return [...shown, {
        kind: 'summary', title: notificationTitle('summary', `${folded.length} more issue updates`),
        body: 'Open the Issues menu to see them', url: null,
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

/**
 * Which notification is each issue's newest banner. Kept out of the Shell code so it can be
 * tested: replacing must never destroy a banner another issue still needs (a summary banner
 * covers several issues), and the caller destroys the superseded banners before adding the
 * new one, so they never take a queue or per-source slot from it.
 */
export class BannerBook {
    constructor() {
        this._byIssue = new Map();
    }

    /** The older banners a new one for `ids` leaves no issue needing. */
    superseded(ids) {
        const older = new Set();
        for (const id of ids) {
            if (this._byIssue.has(id))
                older.add(this._byIssue.get(id));
        }
        for (const [id, banner] of this._byIssue) {
            if (!ids.includes(id))
                older.delete(banner);
        }
        return [...older];
    }

    /** Record `banner` as the newest for `ids`. */
    record(banner, ids) {
        for (const id of ids)
            this._byIssue.set(id, banner);
    }

    forget(banner) {
        for (const [id, recorded] of this._byIssue) {
            if (recorded === banner)
                this._byIssue.delete(id);
        }
    }
}

/** `text` cut to `characters` code points with a trailing "…", so an emoji's surrogate pair is never split. */
export function truncate(text, characters) {
    const codePoints = [...text];
    if (codePoints.length <= characters)
        return text;
    return `${codePoints.slice(0, characters - 1).join('')}…`;
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
