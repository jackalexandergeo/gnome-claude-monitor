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
GLib.spawn_command_line_sync(`rm -rf ${stateHome}`);

print('');
print(failures === 0 ? 'ALL TESTS PASSED' : `${failures} TEST(S) FAILED`);
if (failures > 0)
    imports.system.exit(1);
