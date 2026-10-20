/* pingService.js — watches pingwatch's state.json and runs the actions its menu offers.
 *
 * Async throughout (Gio promisified) so the compositor main loop never blocks. Emits
 * {state, now, notifications} to listeners; state is null while pingwatch is absent,
 * which keeps the whole Issues feature hidden.
 *
 * What was last announced is kept on disk: the shell disables extensions while the screen
 * is locked, and a change that happened meanwhile must still be announced after unlock.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {
    parseState, notificationsBetween, limitNotifications, announcedMap, stateFromAnnounced,
} from './pings.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'pingwatch']);
const STATE_FILE = 'state.json';
const ANNOUNCED_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'claude-usage']);
const ANNOUNCED_FILE = 'pings-announced.json';
const REFRESH_SECS = 15;       // re-read even without a change event: staleness + late-created dir
const DEBOUNCE_MS = 200;       // the hub replaces the file atomically; coalesce the burst of events

/** A file:// page in the hub's runtime folder (next to its socket), under board-open/. */
export function isPrivateBoardPage(url, socketPath) {
    if (typeof url !== 'string' || !url.startsWith('file://') || !socketPath)
        return false;
    let path;
    try {
        [path] = GLib.filename_from_uri(url);
    } catch (_error) {
        return false;
    }
    const folder = GLib.build_filenamev([GLib.path_get_dirname(socketPath), 'board-open']);
    return path.startsWith(`${folder}/`) && path.endsWith('.html') && !path.split('/').includes('..') &&
        GLib.path_get_dirname(path) === folder;
}

export class PingService {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._listeners = [];
        this._monitor = null;
        this._monitorId = 0;
        this._timeoutId = 0;
        this._debounceId = 0;
        this._state = null;
        this._announced = undefined;   // undefined: not loaded yet; null: nothing remembered
        this._announcedText = null;
        this._lastSnapshot = null;
        this._pending = new Map();   // issue id -> {sequence, baseline}: its newest needs-you banner, unread
        // Saves run one after another and are not cancelled by stop(): the shell disables
        // the extension on lock, and the last save is the one that matters then.
        this._saveChain = Promise.resolve();
        this._refreshing = false;
        this._refreshAgain = false;
        this._stopped = false;
        this._decoder = new TextDecoder('utf-8');
        this._encoder = new TextEncoder();
    }

    connect(callback) {
        this._listeners.push(callback);
    }

    start() {
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECS, () => {
            this._ensureMonitor();
            this.refreshNow();
            return GLib.SOURCE_CONTINUE;
        });
        this._ensureMonitor();
        this.refreshNow();
    }

    stop() {
        this._stopped = true;
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        if (this._debounceId) {
            GLib.source_remove(this._debounceId);
            this._debounceId = 0;
        }
        if (this._monitor) {
            if (this._monitorId)
                this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
            this._monitor = null;
            this._monitorId = 0;
        }
        this._cancellable.cancel();
        this._listeners = [];
        this._state = null;
    }

    // pingwatch may be installed after the extension starts, so keep trying until the
    // directory exists, then watch it (a directory monitor survives the atomic rename).
    _ensureMonitor() {
        if (this._monitor || this._stopped)
            return;
        const directory = Gio.File.new_for_path(STATE_DIR);
        if (!directory.query_exists(null))
            return;
        try {
            this._monitor = directory.monitor_directory(Gio.FileMonitorFlags.WATCH_MOVES, this._cancellable);
            this._monitorId = this._monitor.connect('changed', (_monitor, file, otherFile) => {
                if (file?.get_basename() === STATE_FILE || otherFile?.get_basename() === STATE_FILE)
                    this._onChanged();
            });
        } catch (error) {
            logError(error, 'claude-usage: cannot monitor pingwatch state dir');
        }
    }

    _onChanged() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this.refreshNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    async refreshNow() {
        if (this._stopped)
            return;
        // One at a time: a timer tick and a file event landing together would otherwise
        // compare against the same old state and announce one change twice.
        if (this._refreshing) {
            this._refreshAgain = true;
            return;
        }
        this._refreshing = true;
        try {
            do {
                this._refreshAgain = false;
                await this._refreshOnce();
            } while (this._refreshAgain && !this._stopped);
        } finally {
            this._refreshing = false;
        }
    }

    async _refreshOnce() {
        if (this._announced === undefined)
            this._announced = await this._loadAnnounced();
        if (this._stopped)
            return;
        const file = Gio.File.new_for_path(GLib.build_filenamev([STATE_DIR, STATE_FILE]));
        let next = null;
        let missing = false;
        try {
            const [contents] = await file.load_contents_async(this._cancellable);
            next = parseState(this._decoder.decode(contents));
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // NOT_FOUND: pingwatch is not installed, not started yet, or was removed.
            missing = Boolean(error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND));
            if (!missing)
                logError(error, 'claude-usage: cannot read pingwatch state');
        }
        if (this._stopped)
            return;
        // No file hides the button. An unreadable one is most likely a torn write, so the
        // last good snapshot stays rather than blanking the menu.
        const state = missing ? null : next ?? this._state;
        let notifications = [];
        if (next) {
            // Nothing remembered (first ever start): take what is there as already seen.
            notifications = limitNotifications(notificationsBetween(this._announced, next));
            for (const notification of notifications) {
                for (const item of notification.pending) {
                    // Only an issue's newest banner settles it: an older one is replaced
                    // (or evicted), and reading the newest means the user has seen it.
                    const entry = this._pending.get(item.id);
                    if (entry)
                        entry.sequence++;   // keep the earliest baseline
                    else
                        this._pending.set(item.id, { sequence: 1, baseline: item.baseline });
                    item.sequence = this._pending.get(item.id).sequence;
                }
            }
            this._announced = stateFromAnnounced(announcedMap(next));
            this._lastSnapshot = next;
            this._saveAnnounced();
        }
        this._state = state;
        const payload = { state, now: Date.now(), notifications };
        for (const listener of this._listeners)
            listener(payload);
    }

    async _loadAnnounced() {
        const file = Gio.File.new_for_path(GLib.build_filenamev([ANNOUNCED_DIR, ANNOUNCED_FILE]));
        try {
            const [contents] = await file.load_contents_async(this._cancellable);
            this._announcedText = this._decoder.decode(contents);
            return stateFromAnnounced(JSON.parse(this._announcedText));
        } catch (error) {
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) &&
                !error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(error, 'claude-usage: cannot read announced pings; starting fresh');
            return null;
        }
    }

    /** The user dismissed (or clicked) a notification: what it was pending for is settled. */
    acknowledge(pending) {
        for (const { id, sequence } of pending) {
            if (this._pending.get(id)?.sequence === sequence)
                this._pending.delete(id);   // an older banner's dismissal settles nothing
        }
        this._saveAnnounced();
    }

    _saveAnnounced() {
        if (!this._lastSnapshot)
            return this._saveChain;
        const baselines = new Map([...this._pending].map(([id, entry]) => [id, entry.baseline]));
        const text = JSON.stringify(announcedMap(this._lastSnapshot, baselines));
        if (text === this._announcedText)
            return this._saveChain;
        this._announcedText = text;
        this._saveChain = this._saveChain.then(() => this._write(text));
        return this._saveChain;
    }

    async _write(text) {
        try {
            GLib.mkdir_with_parents(ANNOUNCED_DIR, 0o700);
            const file = Gio.File.new_for_path(GLib.build_filenamev([ANNOUNCED_DIR, ANNOUNCED_FILE]));
            await file.replace_contents_bytes_async(new GLib.Bytes(this._encoder.encode(text)), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (error) {
            logError(error, 'claude-usage: cannot save announced pings');
        }
    }

    /** For tests: resolves once every save so far is on disk. */
    flushed() {
        return this._saveChain;
    }

    /**
     * POST JSON to the hub over its local socket (HTTP over a Unix socket: the hub accepts
     * only this user's processes). Resolves to { status, body, error }: status 0 when the
     * hub could not be reached; error set for anything but a 200.
     */
    async _post(socketPath, path, payload, what) {
        if (this._stopped)
            return { status: 0, body: null, error: 'pingwatch was turned off' };
        if (!socketPath)
            return { status: 0, body: null, error: 'pingwatch did not say where to reach it' };
        const session = new Soup.Session({ remote_connectable: Gio.UnixSocketAddress.new(socketPath), timeout: 10 });
        const message = Soup.Message.new('POST', `http://pingwatch${path}`);
        message.set_request_body_from_bytes('application/json',
            new GLib.Bytes(this._encoder.encode(JSON.stringify(payload))));
        let bytes;
        try {
            bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        } catch (error) {
            logError(error, `claude-usage: could not send ${what} to pingwatch`);
            return { status: 0, body: null, error: error.message };
        }
        const status = message.get_status();
        let body = null;
        try {
            body = JSON.parse(this._decoder.decode(bytes.toArray()));
        } catch (_parseError) {
        }
        if (status === 200)
            return { status, body, error: null };
        const error = body?.error || `HTTP ${status}`;
        log(`claude-usage: pingwatch answered ${status} to ${what}: ${error}`);
        return { status, body, error };
    }

    /** Send the user's approve/reject of a gate to the hub. Resolves to { status, error }. */
    async decide(socketPath, issueId, gate, approve) {
        if (!Number.isInteger(issueId))
            return { status: 0, error: 'pingwatch did not say which issue this is' };
        const { status, error } = await this._post(socketPath, `/v1/issues/${issueId}/decisions`, { gate, approve },
            `the ${gate} decision for issue ${issueId}`);
        if (status !== 0)   // the hub answered: show what it did
            this.refreshNow();
        return { status, error };
    }

    /** Close an issue as won't do (out of scope). Resolves to { status, error }. */
    async close(socketPath, issueId) {
        if (!Number.isInteger(issueId))
            return { status: 0, error: 'pingwatch did not say which issue this is' };
        const { status, error } = await this._post(socketPath, `/v1/issues/${issueId}/close`, {},
            `closing issue ${issueId}`);
        if (status !== 0)
            this.refreshNow();
        return { status, error };
    }

    /**
     * Open the issue's card on the board. The hub hands out a private page in its own
     * runtime folder that signs in once (a sign-in code on a command line could be read
     * and spent by another user), so it is asked each time, and nothing else is opened.
     * Resolves to { status, error }.
     */
    async openOnBoard(socketPath, issueId) {
        if (!Number.isInteger(issueId))
            return { status: 0, error: 'pingwatch did not say which issue this is' };
        const { status, body, error } = await this._post(socketPath, `/v1/issues/${issueId}/board-link`, {},
            `the board link for issue ${issueId}`);
        if (error)
            return { status, error };
        if (!isPrivateBoardPage(body?.url, socketPath))
            return { status: 0, error: 'pingwatch sent a board link that is not its own sign-in page' };
        this.openURL(body.url);
        return { status, error: null };
    }

    openURL(url) {
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (error) {
            logError(error, `claude-usage: cannot open ${url}`);
        }
    }

    // argv, never a shell string: the session id comes from a file other code writes.
    attachSession(sessionId) {
        const claude = GLib.find_program_in_path('claude') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'claude']);
        try {
            Gio.Subprocess.new(['gnome-terminal', '--', claude, 'attach', sessionId], Gio.SubprocessFlags.NONE);
        } catch (error) {
            logError(error, `claude-usage: cannot open agent ${sessionId}`);
        }
    }
}
