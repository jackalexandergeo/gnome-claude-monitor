#!/usr/bin/env gjs -m
// Tests for the pingwatch Issues logic. Run: gjs -m test/pings-test.js
import {
    parseState, isStale, panelSummary, headerLine, issueActions, notificationsBetween,
    statusLabel, formatAgo, STALE_AFTER_MS,
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
        source: 'chat', url: 'https://chat.example/team/pl/p1', links: {},
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
check('header warns when stale', headerLine(state({}), NOW + STALE_AFTER_MS + 1).startsWith('⚠ hub not responding'));
check('header mentions untriaged', headerLine(state({ counts: { today: 0, total: 0, open: 0, untriaged: 3 } }), NOW).includes('untriaged: 3'));

// actions
const full = issueActions(issue({
    links: {
        ticket: { url: 'https://git.example/demo/-/issues/12', reference: '#12' },
        mergeRequests: [{ url: 'https://git.example/demo/-/merge_requests/34', reference: '!34' }, { url: 'javascript:alert(1)' }],
        sessions: [{ role: 'research', sessionId: 'a1b2c3d4' }, { role: 'evil', sessionId: '; rm -rf ~' }],
    },
}));
check('actions in order: thread, ticket, MR, agent',
    full.map(action => action.label).join('|') === 'Thread (chat)|Ticket #12|MR !34|Agent: research');
check('actions drop non-web URLs and unsafe session ids', full.length === 4);
check('no url, no thread action', issueActions(issue({ url: null })).length === 0);
check('session ids that would read as options are dropped',
    issueActions(issue({ url: null, links: { sessions: [{ role: 'a', sessionId: '--help' }, { role: 'b', sessionId: '-x' }] } })).length === 0);

// notifications
check('nothing announced on first load', notificationsBetween(null, state({})).length === 0);
const triaging = state({ issues: [issue({ status: 'triaging', kind: null })] });
const triaged = state({ issues: [issue({})] });
const announced = notificationsBetween(triaging, triaged);
check('new issue announced once triaged', announced.length === 1 && announced[0].title === 'New issue: [demo-project]: Build server disk full');
check('same issue not announced twice', notificationsBetween(triaged, triaged).length === 0);
check('needs-you announced on transition',
    notificationsBetween(triaged, state({ issues: [issue({ status: 'needs-you' })] }))[0]?.title.startsWith('Needs you:'));
check('dismissed pings are not announced',
    notificationsBetween(state({ issues: [] }), state({ issues: [issue({ kind: 'social', status: 'ignored' })] })).length === 0);

// formatting
check('status labels', statusLabel('needs-you') === 'needs you' && statusLabel('weird') === 'weird');
check('formatAgo', formatAgo(30_000) === 'just now' && formatAgo(5 * 60_000) === '5m ago' && formatAgo(3 * 3600_000) === '3h ago');

print('');
print(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
if (failures > 0)
    imports.system.exit(1);
