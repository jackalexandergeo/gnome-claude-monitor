#!/usr/bin/env gjs -m
// Tests for PingService's file handling. Run: gjs -m test/ping-service-test.js
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// Before the service module loads: it resolves its directory from XDG_STATE_HOME.
const stateHome = GLib.dir_make_tmp('ping-service-test-XXXXXX');
GLib.setenv('XDG_STATE_HOME', stateHome, true);
const { PingService } = await import('../claude-usage@aidan.local/pingService.js');

let failures = 0;
function check(name, cond) {
    if (cond) {
        print(`  ok   ${name}`);
    } else {
        print(`  FAIL ${name}`);
        failures++;
    }
}

const directory = GLib.build_filenamev([stateHome, 'pingwatch']);
const statePath = GLib.build_filenamev([directory, 'state.json']);
GLib.mkdir_with_parents(directory, 0o755);

function snapshot(status) {
    return JSON.stringify({
        version: 1, updatedAt: Date.now(), counts: { open: 1 },
        issues: [{ id: 1, name: '[demo]: Disk full', status, kind: 'issue', url: 'https://chat.example/1' }],
        otherPings: [],
    });
}

// Like the hub: write a temp file, then rename it over the real one.
function write(text) {
    GLib.file_set_contents(`${statePath}.tmp`, text);
    GLib.rename(`${statePath}.tmp`, statePath);
}

// Everything below runs in try, so the temp dir goes even when a check crashes.
try {
const service = new PingService();
let last = null;
service.connect(payload => {
    last = payload;
});

await service.refreshNow();
check('no file: state is null (the button stays hidden)', last?.state === null);

write(snapshot('new'));
await service.refreshNow();
check('file written: state is read', last?.state?.issues[0]?.status === 'new');
check('first read announces nothing', last.notifications.length === 0);

write('{"version": 1, "issues": [');
await service.refreshNow();
check('torn file: the last good state is kept', last?.state?.issues[0]?.status === 'new');

GLib.unlink(statePath);
await service.refreshNow();
check('file deleted: state goes back to null', last?.state === null);
service.stop();

// The screen locks (extension disabled), an agent starts waiting on you, the screen
// unlocks (a fresh service): that change must still be announced.
write(snapshot('new'));
const beforeLock = new PingService();
beforeLock.connect(() => {});
await beforeLock.refreshNow();
beforeLock.stop();
await beforeLock.flushed();
write(snapshot('needs-you'));
const afterUnlock = new PingService();
const announced = [];
afterUnlock.connect(payload => announced.push(...payload.notifications));
await afterUnlock.refreshNow();
check('a change made while locked is announced after unlock',
    announced.length === 1 && announced[0].title === '❗ Needs you: [demo]: Disk full');

// That banner was never dismissed and the screen locks again: the shell destroys it, so
// after the next unlock it must be raised again. Once dismissed, it stays announced.
afterUnlock.stop();
await afterUnlock.flushed();
const secondUnlock = new PingService();
const raisedAgain = [];
secondUnlock.connect(payload => raisedAgain.push(...payload.notifications));
await secondUnlock.refreshNow();
check('an undismissed needs-you cleared by a lock is raised again', raisedAgain.length === 1);
secondUnlock.acknowledge(raisedAgain[0].pending);
secondUnlock.stop();
await secondUnlock.flushed();
const thirdUnlock = new PingService();
const afterDismissal = [];
thirdUnlock.connect(payload => afterDismissal.push(...payload.notifications));
await thirdUnlock.refreshNow();
check('a dismissed notification is not raised again', afterDismissal.length === 0);
thirdUnlock.stop();
await thirdUnlock.flushed();

// A needs-you answered without touching its banner must not come back
// as a "New issue" after the next unlock (nor after every one after that).
async function lockCycle(statusesBeforeLock, statusAtUnlock) {
    const before = new PingService();
    const raisedBefore = [];
    before.connect(payload => raisedBefore.push(...payload.notifications));
    for (const status of statusesBeforeLock) {
        write(snapshot(status));
        await before.refreshNow();
    }
    write(snapshot(statusAtUnlock));
    await before.refreshNow();
    before.stop();
    await before.flushed();
    const after = new PingService();
    const raisedAfter = [];
    after.connect(payload => raisedAfter.push(...payload.notifications));
    await after.refreshNow();
    after.stop();
    await after.flushed();
    return raisedAfter.map(notification => notification.title);
}
// new -> needs-you (banner raised, never touched) -> answered, in review -> lock -> unlock
check('a needs-you answered before the lock is not raised after it',
    (await lockCycle(['new', 'needs-you'], 'in-review')).length === 0);
check('and it stays quiet on later unlocks', (await lockCycle(['in-review'], 'in-review')).length === 0);

// A New-issue banner is announced once; a lock does not bring it back.
write(JSON.stringify({ version: 1, updatedAt: Date.now(), counts: { open: 0 }, issues: [], otherPings: [] }));
const empty = new PingService();
empty.connect(() => {});
await empty.refreshNow();
empty.stop();
await empty.flushed();
check('a New-issue banner is not raised again after a lock', (await lockCycle(['new'], 'new')).length === 0);

// Dismissing an older banner must not settle a newer, unread needs-you.
write(JSON.stringify({ version: 1, updatedAt: Date.now(), counts: { open: 0 }, issues: [], otherPings: [] }));
const fresh = new PingService();
fresh.connect(() => {});
await fresh.refreshNow();
const banners = [];
fresh.connect(payload => banners.push(...payload.notifications));
write(snapshot('new'));
await fresh.refreshNow();          // "New issue"
write(snapshot('needs-you'));
await fresh.refreshNow();          // "Needs you", left unread
fresh.acknowledge(banners[0].pending);   // the old "New issue" banner is dismissed
fresh.stop();
await fresh.flushed();
const unlocked = new PingService();
const raisedAtUnlock = [];
unlocked.connect(payload => raisedAtUnlock.push(...payload.notifications));
await unlocked.refreshNow();
check('dismissing an older banner leaves a newer needs-you pending',
    raisedAtUnlock.length === 1 && raisedAtUnlock[0].kind === 'needs-you');
unlocked.stop();

// Only an issue's newest banner settles it: dismissing an older one (its question has
// since changed) leaves it pending, dismissing the newest settles it.
{
    write(JSON.stringify({ version: 1, updatedAt: Date.now(), counts: { open: 0 }, issues: [], otherPings: [] }));
    const watcher = new PingService();
    const banners = [];
    watcher.connect(payload => banners.push(...payload.notifications));
    await watcher.refreshNow();
    const asking = question => JSON.stringify({
        version: 1, updatedAt: Date.now(), counts: { open: 1 }, otherPings: [],
        issues: [{ id: 1, name: '[demo]: Disk full', status: 'needs-you', kind: 'issue', question }],
    });
    write(asking('first question'));
    await watcher.refreshNow();
    write(asking('second question'));
    await watcher.refreshNow();
    check('a changed question raises a second banner', banners.length === 2);
    watcher.acknowledge(banners[0].pending);   // the older one
    watcher.stop();
    await watcher.flushed();
    const afterOlder = new PingService();
    const raisedAfterOlder = [];
    afterOlder.connect(payload => raisedAfterOlder.push(...payload.notifications));
    await afterOlder.refreshNow();
    check('dismissing the older banner leaves the issue pending', raisedAfterOlder.length === 1);
    afterOlder.acknowledge(raisedAfterOlder[0].pending);   // now the newest
    afterOlder.stop();
    await afterOlder.flushed();
    const afterNewest = new PingService();
    const raisedAfterNewest = [];
    afterNewest.connect(payload => raisedAfterNewest.push(...payload.notifications));
    await afterNewest.refreshNow();
    check('dismissing the newest settles it', raisedAfterNewest.length === 0);
    afterNewest.stop();
}

// decide() talks HTTP over the hub's Unix socket: check the path, the body and an error.
{
    const socketPath = GLib.build_filenamev([stateHome, 'hub.sock']);
    const listener = new Gio.SocketListener();
    listener.add_address(Gio.UnixSocketAddress.new(socketPath), Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
    let request = '';
    // Everything async: the client runs on this same main loop, so a blocking read here
    // would wait forever for a request that can never be sent.
    listener.accept_async(null, (_listener, result) => {
        const connection = listener.accept_finish(result)[0];
        // Read until the headers and Content-Length bytes of body are in: the client may
        // send them as separate writes.
        const readMore = () => connection.get_input_stream().read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null,
            (input, readResult) => {
                const chunk = input.read_bytes_finish(readResult).toArray();
                request += new TextDecoder().decode(chunk);
                const headerEnd = request.indexOf('\r\n\r\n');
                const length = Number(/content-length: *(\d+)/i.exec(request)?.[1] ?? 0);
                if (chunk.length > 0 && (headerEnd < 0 || request.length - headerEnd - 4 < length)) {
                    readMore();
                    return;
                }
                const body = '{"error": "nothing is waiting on a ticket decision for this issue"}';
                connection.get_output_stream().write_all(new TextEncoder().encode(
                    `HTTP/1.0 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`), null);
                connection.close(null);
            });
        readMore();
    });
    const deciding = new PingService();
    const answer = await deciding.decide(socketPath, 7, 'ticket', true);
    check('decide POSTs to the issue\'s decisions path', request.startsWith('POST /v1/issues/7/decisions'));
    check('with the gate and the answer', request.includes('{"gate":"ticket","approve":true}'));
    check('and hands back the hub\'s refusal', answer.status === 409 && answer.error === 'nothing is waiting on a ticket decision for this issue');
    const nowhere = await deciding.decide(GLib.build_filenamev([stateHome, 'nothing.sock']), 7, 'ticket', true);
    check('an unreachable hub is an error too, not silence', nowhere.status === 0 && nowhere.error);
    const noSocket = await deciding.decide(null, 7, 'ticket', true);
    check('no socket named is an error with a reason', noSocket.status === 0 && typeof noSocket.error === 'string');
    deciding.stop();
    const afterStop = await deciding.decide(socketPath, 7, 'ticket', true);
    check('a stopped service sends nothing', afterStop.status === 0 && afterStop.error === 'pingwatch was turned off');
    listener.close();
}

// startIssue() posts to the issue's start path; the hub's 202 (started, or queued) is not an error.
{
    const socketPath = GLib.build_filenamev([stateHome, 'start-hub.sock']);
    const listener = new Gio.SocketListener();
    listener.add_address(Gio.UnixSocketAddress.new(socketPath), Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
    let request = '';
    listener.accept_async(null, (_listener, result) => {
        const connection = listener.accept_finish(result)[0];
        const readMore = () => connection.get_input_stream().read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null,
            (input, readResult) => {
                const chunk = input.read_bytes_finish(readResult).toArray();
                request += new TextDecoder().decode(chunk);
                const headerEnd = request.indexOf('\r\n\r\n');
                const length = Number(/content-length: *(\d+)/i.exec(request)?.[1] ?? 0);
                if (chunk.length > 0 && (headerEnd < 0 || request.length - headerEnd - 4 < length)) {
                    readMore();
                    return;
                }
                const body = '{"queued": true, "ahead": 1}';
                connection.get_output_stream().write_all(new TextEncoder().encode(
                    `HTTP/1.0 202 Accepted\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`), null);
                connection.close(null);
            });
        readMore();
    });
    const starting = new PingService();
    const answer = await starting.startIssue(socketPath, 8);
    check('startIssue POSTs to the issue\'s start path', request.startsWith('POST /v1/issues/8/start'));
    check('and a 202 is a start, not an error', answer.status === 202 && answer.error === null);
    starting.stop();
    listener.close();
}

// openOnBoard() asks the hub for a one-time link each time and opens only a web address.
{
    const socketPath = GLib.build_filenamev([stateHome, 'board-hub.sock']);
    const listener = new Gio.SocketListener();
    listener.add_address(Gio.UnixSocketAddress.new(socketPath), Gio.SocketType.STREAM, Gio.SocketProtocol.DEFAULT, null);
    const page = GLib.filename_to_uri(GLib.build_filenamev([stateHome, 'board-open', 'a1b2.html']), null);
    const answers = [
        ['200 OK', JSON.stringify({ url: page })],
        ['200 OK', '{"url": "http://127.0.0.1:4321/#code=once&card=c7"}'],
        ['200 OK', JSON.stringify({ url: GLib.filename_to_uri(GLib.build_filenamev([stateHome, 'board-open', '..', 'x.html']), null) })],
        ['200 OK', '{"url": "file:///etc/passwd"}'],
        ['404 Not Found', '{"error": "issue 7 has no card on the board"}'],
    ];
    const requests = [];
    const serveNext = () => listener.accept_async(null, (_listener, result) => {
        const connection = listener.accept_finish(result)[0];
        let request = '';
        const readMore = () => connection.get_input_stream().read_bytes_async(4096, GLib.PRIORITY_DEFAULT, null,
            (input, readResult) => {
                const chunk = input.read_bytes_finish(readResult).toArray();
                request += new TextDecoder().decode(chunk);
                const headerEnd = request.indexOf('\r\n\r\n');
                const length = Number(/content-length: *(\d+)/i.exec(request)?.[1] ?? 0);
                if (chunk.length > 0 && (headerEnd < 0 || request.length - headerEnd - 4 < length)) {
                    readMore();
                    return;
                }
                requests.push(request);
                const [statusLine, body] = answers.shift();
                connection.get_output_stream().write_all(new TextEncoder().encode(
                    `HTTP/1.0 ${statusLine}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`), null);
                connection.close(null);
                if (answers.length)
                    serveNext();
            });
        readMore();
    });
    serveNext();
    const boarding = new PingService();
    const opened = [];
    boarding.openURL = url => opened.push(url);
    const first = await boarding.openOnBoard(socketPath, 7);
    check('openOnBoard POSTs to the issue\'s board-link path', requests[0].startsWith('POST /v1/issues/7/board-link'));
    check('and opens the hub\'s own sign-in page', first.error === null && opened.join() === page);
    for (const what of ['a web link (its code would sit on a command line)', 'a page outside the folder', 'any other file']) {
        const refused = await boarding.openOnBoard(socketPath, 7);
        check(`${what} is not opened`, refused.error && opened.length === 1);
    }
    const noCard = await boarding.openOnBoard(socketPath, 7);
    check('the hub\'s reason comes back when there is no card', noCard.status === 404 &&
        noCard.error === 'issue 7 has no card on the board');
    boarding.stop();
    listener.close();
}

// A change written while a refresh is still running must not be lost: the refresh
// asked for meanwhile runs right after, and announces it exactly once.
write(snapshot('new'));
const busy = new PingService();
const seen = [];
const raised = [];
let changedMidRefresh = false;
busy.connect(payload => {
    seen.push(payload.state?.issues[0]?.status);
    raised.push(...payload.notifications);
    if (!changedMidRefresh) {
        changedMidRefresh = true;
        write(snapshot('needs-you'));
        busy.refreshNow();   // lands while the first refresh is still running
        busy.refreshNow();   // and a second ask must not run a third refresh
    }
});
await busy.refreshNow();
await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => resolve() ?? GLib.SOURCE_REMOVE));
check('a change written mid-refresh is picked up right after', seen.join(',') === 'new,needs-you');
check('and announced once', raised.length === 1 && raised[0].kind === 'needs-you');
busy.stop();


} finally {
    // argv, not a command line: a temp dir path with a space must not split.
    GLib.spawn_sync(null, ['rm', '-rf', '--', stateHome], null, GLib.SpawnFlags.SEARCH_PATH, null);
}

print('');
print(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
if (failures > 0)
    imports.system.exit(1);
