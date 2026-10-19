/* pingService.js — watches pingwatch's state.json and runs the actions its menu offers.
 *
 * Async throughout (Gio promisified) so the compositor main loop never blocks. Emits
 * {state, now, notifications} to listeners; state is null while pingwatch is absent,
 * which keeps the whole Issues feature hidden.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { parseState, notificationsBetween } from './pings.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');

const STATE_DIR = GLib.build_filenamev([GLib.get_user_state_dir(), 'pingwatch']);
const STATE_FILE = 'state.json';
const REFRESH_SECS = 15;       // re-read even without a change event: staleness + late-created dir
const DEBOUNCE_MS = 200;       // the hub replaces the file atomically; coalesce the burst of events

export class PingService {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._listeners = [];
        this._monitor = null;
        this._monitorId = 0;
        this._timeoutId = 0;
        this._debounceId = 0;
        this._state = null;
        this._stopped = false;
        this._decoder = new TextDecoder('utf-8');
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
        const file = Gio.File.new_for_path(GLib.build_filenamev([STATE_DIR, STATE_FILE]));
        let next = null;
        try {
            const [contents] = await file.load_contents_async(this._cancellable);
            next = parseState(this._decoder.decode(contents));
        } catch (error) {
            if (error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // NOT_FOUND just means pingwatch is not installed or not started yet.
            if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                logError(error, 'claude-usage: cannot read pingwatch state');
        }
        if (this._stopped)
            return;
        // Keep the last good snapshot through a bad read, so a torn file doesn't blank the menu.
        const state = next ?? this._state;
        const notifications = next ? notificationsBetween(this._state, next) : [];
        this._state = state;
        const payload = { state, now: Date.now(), notifications };
        for (const listener of this._listeners)
            listener(payload);
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
