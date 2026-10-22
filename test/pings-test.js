#!/usr/bin/env gjs -m
// Tests for the pingwatch Issues logic. Run: gjs -m test/pings-test.js
import {
    parseState, isStale, panelSummary, headerLine, issueActions, notificationsBetween,
    statusLabel, formatAgo, STALE_AFTER_MS, limitNotifications, MAX_NOTIFICATIONS_AT_ONCE,
    announcedMap, stateFromAnnounced, sourceWarnings, BannerBook, truncate, usageLine, agentsOfLimit, lastRename,
    NOTIFICATION_KINDS, notificationTitle, canStart, boardColumns, focusFirst,
} from '../claude-usage@aidan.local/pings.js';

let failures = 0;
function check(name, cond) {
    if (cond) {
        print(`  ok   ${name}`);
    } else {
        print(`  FAIL ${name}`);
        failures++;
    }
}

const NOW = 1_800_000_000_000;

function issue(fields) {
    return Object.assign({
        id: 1, name: '[demo-project]: Build server disk full', status: 'new', kind: 'issue',
        source: 'chat', url: 'https://chat.example/thread/1', links: {},
        lastPing: { author: 'alex', preview: 'can you check the disk?' },
    }, fields);
}

function state(fields) {
    return Object.assign({
        updatedAt: NOW, counts: { today: 2, total: 9, open: 2, untriaged: 0 }, issues: [issue({})], otherPings: [],
    }, fields);
}

// parseState
check('parseState accepts version 1', parseState(JSON.stringify({ version: 1, updatedAt: 5, counts: { open: 3 }, issues: [] }))?.counts.open === 3);
check('parseState rejects a newer format', parseState(JSON.stringify({ version: 2 })) === null);
check('parseState rejects garbage', parseState('{not json') === null && parseState('') === null && parseState('null') === null);
check('parseState drops malformed issues',
    parseState(JSON.stringify({ version: 1, issues: [{ id: 1 }, { id: 'x' }, null, 'str'] })).issues.length === 1);
check('parseState fills missing counts with 0', parseState(JSON.stringify({ version: 1 })).counts.today === 0);
check('parseState names an unnamed issue',
    parseState(JSON.stringify({ version: 1, issues: [{ id: 1 }, { id: 2, name: 7 }, { id: 3, name: 'ok' }] }))
        .issues.map(item => item.name).join('|') === '(untitled)|(untitled)|ok');

// staleness + panel
check('fresh state is not stale', !isStale(state({}), NOW + 1000));
check('old state is stale', isStale(state({}), NOW + STALE_AFTER_MS + 1));
check('missing state is stale', isStale(null, NOW));
check('panel shows open count as active', panelSummary(state({}), NOW).text === '2' && panelSummary(state({}), NOW).emphasis === 'active');
check('panel alerts when something needs you',
    panelSummary(state({ issues: [issue({ status: 'needs-you' })] }), NOW).emphasis === 'alert');
check('panel idle with nothing open',
    panelSummary(state({ counts: { today: 0, total: 0, open: 0, untriaged: 0 }, issues: [] }), NOW).emphasis === 'idle');
check('panel shows a dash when the hub is down', panelSummary(state({}), NOW + STALE_AFTER_MS + 1).text === '–');
check('a stale snapshot keeps the needs-you alert',
    panelSummary(state({ issues: [issue({ status: 'needs-you' })] }), NOW + STALE_AFTER_MS + 1).emphasis === 'alert');

// header
check('header lists counts', headerLine(state({}), NOW) === 'Picked up today: 2 · total: 9 · need you: 0');
check('an issue says how much Claude use its agents took',
    usageLine({ fiveHour: { share: 2.2, ofLimit: 1.3 }, week: { share: 0.3, ofLimit: null } }) ===
        'Usage: 2.2% of Claude use this 5 h (≈ 1.3% of the limit) · 0.3% of Claude use this week' &&
    usageLine(null) === null && usageLine({ fiveHour: { share: 'x' } }) === null);
check('the header adds up the agents\' share of the 5-hour limit',
    agentsOfLimit({ issues: [{ usage: { fiveHour: { ofLimit: 1.25 } } }, { usage: { fiveHour: { ofLimit: 2 } } }, {}] }) === 3.3 &&
    agentsOfLimit({ issues: [{}] }) === null &&
    headerLine(state({ issues: [issue({ usage: { fiveHour: { share: 9, ofLimit: 4 } } })] }), NOW).endsWith('agents ≈ 4% of the 5-hour limit'));
check('header warns when stale', headerLine(state({}), NOW + STALE_AFTER_MS + 1).startsWith('⚠ hub not responding'));
check('header mentions untriaged', headerLine(state({ counts: { today: 0, total: 0, open: 0, untriaged: 3 } }), NOW).includes('untriaged: 3'));

// source heartbeats
const withSources = sources => parseState(JSON.stringify({ version: 1, updatedAt: NOW, sources }));
check('a healthy, recent source says nothing',
    sourceWarnings(withSources({ chat: { ok: true, at: NOW - 30_000 } }), NOW).length === 0);
check('an unhealthy source says why',
    sourceWarnings(withSources({ chat: { ok: false, detail: 'login expired', at: NOW } }), NOW)[0] === '⚠ chat: login expired');
check('a silent source says for how long',
    sourceWarnings(withSources({ chat: { ok: true, at: NOW - 12 * 60_000 } }), NOW)[0] === '⚠ chat: no heartbeat for 12m');
check('malformed sources are ignored',
    Object.keys(withSources({ a: null, b: 'x', c: { ok: 'yes' }, d: { ok: true, at: NOW } }).sources).join() === 'd' &&
    Object.keys(withSources(['x']).sources).length === 0);
check('unhealthy sources come first, then silent ones, and the rest fold',
    sourceWarnings(withSources({
        quiet: { ok: true, at: NOW - 12 * 60_000 }, broken: { ok: false, detail: 'x'.repeat(300), at: NOW },
        also: { ok: false, detail: 'down', at: NOW }, never: { ok: true },
    }), NOW).join('|') === `⚠ broken: ${'x'.repeat(79)}…|⚠ also: down|+2 more`);
const smiling = '\u{1F600}';   // two UTF-16 code units
const [emojiWarning] = sourceWarnings(withSources({ chat: { ok: false, detail: smiling.repeat(100), at: NOW } }), NOW);
check('a long emoji detail is cut between emoji, not inside one',
    emojiWarning.isWellFormed() && emojiWarning === `⚠ chat: ${smiling.repeat(79)}…`);
check('a source that never beat says so, not 20000 days',
    sourceWarnings(withSources({ chat: { ok: true } }), NOW)[0] === '⚠ chat: no heartbeat yet');
check('the header leads with the warning',
    headerLine(withSources({ chat: { ok: false, detail: 'login expired', at: NOW } }), NOW).startsWith('⚠ chat: login expired  ·  Picked up today'));

// actions
// The actions about links, sessions and decisions (every open issue also ends with Won't do).
const otherActions = fields => issueActions(fields).filter(action => !['close', 'start'].includes(action.kind));
const full = otherActions(issue({
    links: {
        ticket: { url: 'https://git.example/demo/-/issues/12', reference: '#12' },
        mergeRequests: [{ url: 'https://git.example/demo/-/merge_requests/34', reference: '!34' }, { url: 'javascript:alert(1)' }],
        sessions: [{ role: 'research', sessionId: 'a1b2c3d4' }, { role: 'evil', sessionId: '; rm -rf ~' }],
    },
}));
check('actions in order: thread, ticket, MR, agent',
    full.map(action => action.label).join('|') === 'Thread (chat)|Ticket #12|MR !34|Agent: research');
check('actions drop non-web URLs and unsafe session ids', full.length === 4);
check('no url, no thread action', otherActions(issue({ url: null })).length === 0);
const deciding = otherActions(issue({ url: null, awaiting: ['research', 'ticket', 'everything', 'constructor'] }));
check('each answer says what it will do',
    deciding.every(action => typeof action.consequence === 'string' && action.consequence.length > 10) &&
    deciding.find(action => action.label === "Don't file it").consequence === 'No ticket is filed for this issue.');
check('a waiting review offers its two answers, and only for known gates',
    deciding.map(action => action.label).join('|') === "Accept the research|Send it back|File the ticket|Don't file it" &&
    deciding.every(action => action.kind === 'decision'));
const boarded = otherActions(issue({ url: null, onBoard: true }));
check('an issue with a card offers to open it on the board',
    boarded.length === 1 && boarded[0].kind === 'board' && boarded[0].label === 'Open on the board' &&
    otherActions(issue({ url: null, onBoard: 'yes' })).length === 0);
const closing = issueActions(issue({ url: null, status: 'needs-you' }));
check("an open issue can be closed as won't do, after a confirmation that says what it does",
    closing.length === 1 && closing[0].kind === 'close' && closing[0].label === "Won't do" &&
    closing[0].consequence.includes('its agent stops') &&
    issueActions(issue({ url: null, status: 'wont-do' })).length === 0 && statusLabel('wont-do') === "won't do");
const reviewing = otherActions(issue({ url: null, awaiting: ['review'] }));
check('a low review of the opened MR offers to take it or have it fixed',
    reviewing.map(action => action.label).join('|') === 'Take the MR as it is|Have it fixed' &&
    reviewing.every(action => action.gate === 'review'));
check('the MR states after the agents have names',
    statusLabel('mr-reviewed') === 'MR reviewed: your turn' && statusLabel('awaiting-review') === 'awaits review');
const scoping = otherActions(issue({ url: null, awaiting: ['scope'] }));
check('an issue that may be someone else\'s offers to start anyway or leave it',
    scoping.map(action => action.label).join('|') === 'Start anyway|Leave it to them' &&
    scoping.every(action => action.gate === 'scope'));
check('the hub socket is taken only as an absolute path',
    parseState(JSON.stringify({ version: 1, hub: { socket: '/run/user/1/pingwatch/hub.sock' } })).hubSocket === '/run/user/1/pingwatch/hub.sock' &&
    parseState(JSON.stringify({ version: 1, hub: { socket: 'relative.sock' } })).hubSocket === null);
check('session ids that would read as options are dropped',
    otherActions(issue({ url: null, links: { sessions: [{ role: 'a', sessionId: '--help' }, { role: 'b', sessionId: '-x' }] } })).length === 0);

// notifications
check('nothing announced on first load', notificationsBetween(null, state({})).length === 0);
const beforeRename = state({ issues: [issue({ status: 'researching', name: '[p]: Ticket 12 problem' })] });
const afterRename = state({ issues: [issue({ status: 'in-review', name: '[p]: Label printer skips a line',
    links: { renamed: [{ from: 'Ticket 12 problem', to: 'Label printer skips a line', why: 'after research' }] } })] });
const renames = notificationsBetween(beforeRename, afterRename);
check('a renamed issue is announced with what it was called',
    renames.length === 1 && renames[0].title === '✏️ Renamed: [p]: Label printer skips a line' && renames[0].kind === 'renamed' &&
    renames[0].body === 'Was: [p]: Ticket 12 problem (after research)' &&
    lastRename(afterRename.issues[0]).from === 'Ticket 12 problem' && lastRename(issue({})) === null);
check('a name that changes without a rename is not announced',
    notificationsBetween(beforeRename, state({ issues: [issue({ status: 'researching', name: '[p]: other' })] })).length === 0);
const triaging = state({ issues: [issue({ status: 'triaging', kind: null })] });
const triaged = state({ issues: [issue({})] });
const announced = notificationsBetween(triaging, triaged);
check('new issue announced once triaged', announced.length === 1 && announced[0].title === '🆕 New issue: [demo-project]: Build server disk full' &&
    announced[0].kind === 'new');
check('same issue not announced twice', notificationsBetween(triaged, triaged).length === 0);
check('needs-you announced on transition',
    notificationsBetween(triaged, state({ issues: [issue({ status: 'needs-you' })] }))[0]?.title.startsWith('❗ Needs you: '));
check('dismissed pings are not announced',
    notificationsBetween(state({ issues: [] }), state({ issues: [issue({ kind: 'social', status: 'ignored' })] })).length === 0);

// starting agents from the menu
check('a new issue can be started once', canStart(issue({})) && !canStart(issue({ links: { startRequested: true } })));
check('so can a question or a review request in Other pings',
    canStart(issue({ status: 'ignored', kind: 'review-request' })) && canStart(issue({ status: 'ignored', kind: 'question' })));
check('but not chatter, nor an issue already being worked on',
    !canStart(issue({ status: 'ignored', kind: 'social' })) && !canStart(issue({ status: 'researching' })));
check('the menu offers it before won\'t do',
    issueActions(issue({ url: null })).map(action => action.kind).join() === 'start,close' &&
    issueActions(issue({ url: null, status: 'ignored', kind: 'review-request' })).map(action => action.kind).join() === 'start');

// how each kind of notification looks
check('every kind has an emoji, an icon, and only needs-you is urgent',
    Object.values(NOTIFICATION_KINDS).every(look => look.emoji && look.icon.endsWith('-symbolic')) &&
    Object.entries(NOTIFICATION_KINDS).filter(([, look]) => look.urgent).map(([kind]) => kind).join() === 'needs-you');
check('a kind without a label is its emoji and the text', notificationTitle('problem', 'Could not close it') === '⚠️ Could not close it');
const fromSomeone = notificationsBetween(triaging, state({ issues: [issue({ lastPing: { author: 'alex', preview: 'can you check the disk?' } })] }));
check('a new issue says who asked and what', fromSomeone[0]?.body === '@alex: can you check the disk?');
const mergeRequestOpen = state({ issues: [issue({ status: 'mr-open', links: { mergeRequests: [{ url: 'https://forge/mr/34', reference: '!34' }] } })] });
const mergeRequestReviewed = state({ issues: [issue({ status: 'mr-reviewed', links: { mergeRequests: [{ url: 'https://forge/mr/34', reference: '!34' }] } })] });
const yourTurn = notificationsBetween(mergeRequestOpen, mergeRequestReviewed);
check('when the agents are done with the MR, it is your turn, and the banner opens the MR',
    yourTurn.length === 1 && yourTurn[0].kind === 'your-turn' && yourTurn[0].title === '👀 Your turn: [demo-project]: Build server disk full' &&
    yourTurn[0].body === 'The agents reviewed !34: it is ready for yours' && yourTurn[0].url === 'https://forge/mr/34');
check('and only once', notificationsBetween(mergeRequestReviewed, mergeRequestReviewed).length === 0);

// the popup when a review drops below the bar
const waiting = state({ issues: [issue({ status: 'needs-you', question: 'the verifier scored the research 5/10: the cited line does not exist' })] });
const popup = notificationsBetween(triaged, waiting);
check('the popup says why', popup.length === 1 && popup[0].body === 'the verifier scored the research 5/10: the cited line does not exist');
const secondQuestion = state({ issues: [issue({ status: 'needs-you', question: 'the ticket review scored 4/10: wrong project' })] });
check('a new question on an issue already needing you pops up again', notificationsBetween(waiting, secondQuestion).length === 1);
check('the same question does not', notificationsBetween(waiting, waiting).length === 0);
check('the question survives being remembered',
    notificationsBetween(stateFromAnnounced(JSON.parse(JSON.stringify(announcedMap(waiting)))), waiting).length === 0);

// limiting + remembering
const many = Array.from({ length: 9 }, (_, index) => ({ title: `t${index}`, body: '', url: 'https://x' }));
const limited = limitNotifications(many);
check('a burst is cut to the limit', limited.length === MAX_NOTIFICATIONS_AT_ONCE);
check('the last one summarizes the rest',
    limited[limited.length - 1].title === '📬 6 more issue updates' && limited[limited.length - 1].kind === 'summary');
check('a small batch passes through', limitNotifications(many.slice(0, 2)).length === 2);
const burst = [...many.slice(0, 4), { kind: 'needs-you', title: notificationTitle('needs-you', '[demo]: Disk full'), body: '',
    url: 'https://x', pending: [{ id: 9, baseline: null }] }];
check('needs-you survives a folded burst', limitNotifications(burst)[0].kind === 'needs-you');
check('the summary carries what the folded ones were pending for',
    limitNotifications(burst.map((notification, index) => ({ ...notification, pending: notification.pending ?? [{ id: index, baseline: null }] })))
        .at(-1).pending.length === 2);
const pendingMap = announcedMap(state({ issues: [issue({ id: 1, status: 'needs-you' }), issue({ id: 2 })] }),
    new Map([[1, { status: 'new', kind: 'issue' }]]));
check('a pending needs-you is remembered as it was before',
    pendingMap[1].status === 'new' && pendingMap[2].status === 'new');
check('a pending issue is always remembered, as its baseline',
    announcedMap(state({ issues: [issue({ id: 1, status: 'needs-you' })] }),
        new Map([[1, { status: null, kind: 'issue', question: null }]]))[1].kind === 'issue');
check('an empty question is not news either',
    notificationsBetween(waiting, state({ issues: [issue({ status: 'needs-you', question: '' })] })).length === 0);
check('a question going away does not pop up',
    notificationsBetween(waiting, state({ issues: [issue({ status: 'needs-you', question: null })] })).length === 0);
check('an issue first seen needing you, once answered, is not a "New issue" later',
    (() => {
        const first = notificationsBetween(state({ issues: [] }), waiting)[0];
        const remembered = stateFromAnnounced(JSON.parse(JSON.stringify(
            announcedMap(waiting, new Map([[1, first.pending[0].baseline]])))));
        return notificationsBetween(remembered, state({ issues: [issue({ status: 'in-review' })] })).length === 0;
    })());
check('a map remembered before questions were kept does not re-announce on upgrade',
    notificationsBetween(stateFromAnnounced({ 1: { status: 'needs-you', kind: 'issue' } }), waiting).length === 0);
const remembered = stateFromAnnounced(JSON.parse(JSON.stringify(announcedMap(triaged))));
check('a remembered map round-trips through JSON',
    notificationsBetween(remembered, triaged).length === 0 &&
    notificationsBetween(remembered, state({ issues: [issue({ status: 'needs-you' })] })).length === 1);
check('a corrupt remembered map is ignored', stateFromAnnounced('junk') === null && stateFromAnnounced(null) === null);

// banner bookkeeping
{
    const book = new BannerBook();
    check('a first banner replaces nothing', book.superseded([1]).length === 0);
    book.record('b1', [1]);
    check('a newer banner for the issue replaces the older', book.superseded([1]).join() === 'b1');
    const summaryBook = new BannerBook();
    summaryBook.record('summary', [2, 3]);
    check('a summary banner stays while another folded issue still needs it',
        summaryBook.superseded([2]).length === 0);
    summaryBook.record('b2', [2]);
    check('and goes once no issue needs it', summaryBook.superseded([3]).join() === 'summary');
    check('a banner for all of them replaces every older one', summaryBook.superseded([2, 3]).join() === 'b2,summary');
    summaryBook.record('b3', [3]);
    summaryBook.forget('b3');
    check('a forgotten banner is never handed back', summaryBook.superseded([3]).length === 0);
}

// formatting
check('status labels', statusLabel('needs-you') === 'needs you' && statusLabel('theirs') === "someone else's" &&
    statusLabel('weird') === 'weird');
check('truncate leaves text that fits alone',
    truncate('short', 80) === 'short' && truncate('x'.repeat(80), 80) === 'x'.repeat(80));
check('truncate cuts to the limit, the "…" included', truncate('x'.repeat(81), 80) === `${'x'.repeat(79)}…`);
check('truncate counts an emoji as one character, at either alignment',
    truncate(smiling.repeat(80), 80) === smiling.repeat(80) &&
    [smiling.repeat(81), `x${smiling.repeat(81)}`].every(text => {
        const cut = truncate(text, 80);
        return cut.isWellFormed() && [...cut].length === 80 && cut.endsWith(`${smiling}…`);
    }));
check('formatAgo', formatAgo(30_000) === 'just now' && formatAgo(5 * 60_000) === '5m ago' && formatAgo(3 * 3600_000) === '3h ago');

print('focusFirst');
{
    const columns = boardColumns(JSON.stringify({ posted: { 1: { column: 'Researching' }, 2: { column: 'Clauding' }, 4: {} } }));
    const ordered = focusFirst([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], columns);
    check('a Clauding issue leads, the rest keep their order', ordered.map(issue => issue.id).join() === '2,1,3,4');
    check('it carries its column and focus', ordered[0].boardColumn === 'Clauding' && ordered[0].focus && !ordered[1].focus);
    check('no column when the sync has none', ordered[2].boardColumn === null && ordered[3].boardColumn === null);
    check('an unreadable items file means no columns', boardColumns('{torn').size === 0);
}
print('');
print(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
if (failures > 0)
    imports.system.exit(1);
