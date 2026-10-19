#!/usr/bin/env gjs -m
// Tests for PingService's file handling. Run: gjs -m test/ping-service-test.js
import GLib from 'gi://GLib';

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
    announced.length === 1 && announced[0].title === 'Needs you: [demo]: Disk full');

// That banner was never dismissed and the screen locks again: the shell destroys it, so
// after the next unlock it must be raised again. Once dismissed, it stays announced.
afterUnlock.stop();
await afterUnlock.flushed();
const secondUnlock = new PingService();
const raisedAgain = [];
secondUnlock.connect(payload => raisedAgain.push(...payload.notifications));
await secondUnlock.refreshNow();
check('an undismissed notification cleared by a lock is raised again', raisedAgain.length === 1);
secondUnlock.acknowledge(raisedAgain[0].issueIds);
secondUnlock.stop();
await secondUnlock.flushed();
const thirdUnlock = new PingService();
const afterDismissal = [];
thirdUnlock.connect(payload => afterDismissal.push(...payload.notifications));
await thirdUnlock.refreshNow();
check('a dismissed notification is not raised again', afterDismissal.length === 0);
thirdUnlock.stop();
const afterUnlockAgain = new PingService();
afterUnlockAgain.connect(payload => announced.push(...payload.notifications));
await afterUnlockAgain.refreshNow();

afterUnlockAgain.stop();

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
check('and announced once', raised.length === 1 && raised[0].title.startsWith('Needs you:'));
busy.stop();
// argv, not a command line: a temp dir path with a space must not split.
GLib.spawn_sync(null, ['rm', '-rf', '--', stateHome], null, GLib.SpawnFlags.SEARCH_PATH, null);

print('');
print(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
if (failures > 0)
    imports.system.exit(1);
