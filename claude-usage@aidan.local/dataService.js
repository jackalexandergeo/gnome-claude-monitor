/* dataService.js — all file I/O, monitors, and the refresh engine.
 *
 * Everything here is async (Gio promisified) so the GNOME compositor main loop is
 * never blocked. The service emits a plain state object to registered listeners.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import { sumTokens, computeBlocks, activeBlock, FIVE_HOURS_MS } from './blocks.js';

Gio._promisify(Gio.File.prototype, 'read_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');

const HOME = GLib.get_home_dir();
const SESSIONS_DIR = `${HOME}/.claude/sessions`;
const PROJECTS_DIR = `${HOME}/.claude/projects`;
const CLAUDE_JSON = `${HOME}/.claude.json`;
const CREDENTIALS_JSON = `${HOME}/.claude/.credentials.json`;

// ---- tunables (no prefs UI in v1; edit here to calibrate) ----
const REFRESH_SECS = 10;                       // UI / session / countdown cadence
const USAGE_REFRESH_MS = 60_000;               // how often to actually hit the usage API
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const WINDOW_MS = FIVE_HOURS_MS;               // rolling usage window (for the offline fallback)
const COUNT_CACHE_TOKENS = true;               // include cache read/creation tokens (ccusage headline behaviour)
// Only used for the OFFLINE FALLBACK estimate if the usage API is unreachable.
// Max 5x has no published 5h token cap; calibrate by watching tokens near a real limit.
const CAP_TOKENS_5H = 200_000_000;
const SESSION_DEBOUNCE_MS = 300;               // coalesce rapid session file changes
const ENTRY_RETENTION_MS = 26 * 60 * 60 * 1000; // keep ~26h of entries (covers "today" + 5h block)
const READ_CHUNK = 1 << 18;                    // 256 KiB read chunks

// Read a Gio input stream fully to a string. GJS's TextDecoder has no `{stream:true}`
// option, so we buffer the chunks and decode once at the end.
async function drainStream(stream, cancellable) {
    const chunks = [];
    let total = 0;
    for (;;) {
        const bytes = await stream.read_bytes_async(READ_CHUNK, GLib.PRIORITY_DEFAULT, cancellable);
        const size = bytes.get_size();
        if (size === 0)
            break;
        chunks.push(bytes.toArray());
        total += size;
    }
    if (total === 0)
        return '';
    if (chunks.length === 1)
        return new TextDecoder('utf-8').decode(chunks[0]);
    const buf = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
    }
    return new TextDecoder('utf-8').decode(buf);
}

// Normalize a usage-API window object {utilization, resets_at} -> {util, resetMs, est}.
function windowOf(d) {
    if (!d)
        return null;
    const resetMs = d.resets_at ? Date.parse(d.resets_at) : 0;
    return {
        util: typeof d.utilization === 'number' ? d.utilization : null,
        resetMs: Number.isNaN(resetMs) ? 0 : resetMs,
        est: false,
    };
}

// planLimitsEndDate lives under a GrowthBook feature namespace whose name can change,
// so search for the key wherever it is rather than assuming a fixed path.
function findKey(obj, key, depth = 6) {
    if (depth < 0 || obj === null || typeof obj !== 'object')
        return null;
    if (Array.isArray(obj)) {
        for (const v of obj) {
            const r = findKey(v, key, depth - 1);
            if (r !== null)
                return r;
        }
        return null;
    }
    const v = obj[key];
    if (v !== undefined && (typeof v !== 'object' || v === null))
        return v;
    for (const k in obj) {
        const r = findKey(obj[k], key, depth - 1);
        if (r !== null)
            return r;
    }
    return null;
}

function humanizeTier(raw) {
    if (!raw)
        return 'Unknown';
    const map = {
        default_claude_max_5x: 'Max 5x',
        default_claude_max_20x: 'Max 20x',
        default_claude_pro: 'Pro',
    };
    if (map[raw])
        return map[raw];
    return raw.replace(/^default_claude_/, '').replace(/_/g, ' ');
}

function startOfLocalDay(nowMs) {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

export class DataService {
    constructor() {
        this._cancellable = new Gio.Cancellable();
        this._fileCache = new Map();   // path -> { offset, partial, entries[] }
        this._state = null;
        this._listeners = [];
        this._monitor = null;
        this._monitorId = 0;
        this._timeoutId = 0;
        this._debounceId = 0;
        this._refreshing = false;
        this._dirty = false;
        this._stopped = false;
        this._decoder = new TextDecoder('utf-8');
        this._soup = new Soup.Session({ timeout: 8 });
        this._usageCache = null;       // last good usage windows
        this._usageFetchedAt = 0;      // when we last got a 200
        this._usageAttemptedAt = 0;    // when we last tried the network (success OR failure)
        this._usageLastError = null;   // short reason string from the most recent attempt, or null
    }

    connect(cb) {
        this._listeners.push(cb);
    }

    start() {
        const dir = Gio.File.new_for_path(SESSIONS_DIR);
        try {
            this._monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, this._cancellable);
            this._monitorId = this._monitor.connect('changed', () => this._onSessionsChanged());
        } catch (e) {
            logError(e, 'claude-usage: cannot monitor sessions dir');
        }
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECS, () => {
            this.refreshNow();
            return GLib.SOURCE_CONTINUE;
        });
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
        if (this._soup) {
            this._soup.abort();
            this._soup = null;
        }
        this._listeners = [];
        this._fileCache.clear();
        this._usageCache = null;
        this._state = null;
    }

    _onSessionsChanged() {
        if (this._debounceId)
            GLib.source_remove(this._debounceId);
        this._debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SESSION_DEBOUNCE_MS, () => {
            this._debounceId = 0;
            this.refreshNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    refreshNow() {
        if (this._stopped)
            return;
        if (this._refreshing) {
            this._dirty = true;
            return;
        }
        this._refreshing = true;
        this._refresh()
            .catch(e => {
                if (!(e.matches && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)))
                    logError(e, 'claude-usage: refresh failed');
            })
            .finally(() => {
                this._refreshing = false;
                if (this._dirty) {
                    this._dirty = false;
                    this.refreshNow();
                }
            });
    }

    isPidAlive(pid) {
        return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
    }

    async _refresh() {
        const now = Date.now();
        const [sessions, entries, account] = await Promise.all([
            this._scanSessions(),
            this._readUsageEntries(now),
            this._readAccount(),
        ]);
        const usage = await this._getUsage(now, entries, account.weeklyResetEst);

        const startOfDay = startOfLocalDay(now);
        let todayTokens = 0;
        // Per-session token totals over the retained window, joined onto the live
        // sessions below by sessionId (the transcript's own sessionId == the session
        // file's sessionId). Covers this agent's whole working period (~26h retention).
        const tokensBySession = new Map();
        for (const e of entries) {
            if (e.ts >= startOfDay)
                todayTokens += e.tokens;
            if (e.sessionId)
                tokensBySession.set(e.sessionId, (tokensBySession.get(e.sessionId) || 0) + e.tokens);
        }
        for (const s of sessions)
            s.tokens = tokensBySession.get(s.sessionId) || 0;

        const busyCount = sessions.filter(s => s.status === 'busy').length;
        const idleCount = sessions.length - busyCount;

        this._state = {
            sessions,
            busyCount,
            idleCount,
            fiveHour: usage.fiveHour,
            sevenDay: usage.sevenDay,
            sevenDayOpus: usage.sevenDayOpus,
            sevenDaySonnet: usage.sevenDaySonnet,
            usageSource: usage.source,
            usageFetchedAt: this._usageFetchedAt,
            usageError: this._usageLastError,
            tier: account.tier,
            todayTokens,
            now,
        };

        for (const cb of this._listeners) {
            try {
                cb(this._state);
            } catch (e) {
                logError(e, 'claude-usage: listener failed');
            }
        }
    }

    // ---- usage API (authoritative; same endpoint as Claude Code's /usage) ----
    async _readToken() {
        try {
            const obj = JSON.parse(await this._loadString(CREDENTIALS_JSON));
            return (obj.claudeAiOauth || {}).accessToken || null;
        } catch (e) {
            return null;
        }
    }

    async _fetchUsage() {
        this._usageLastError = null;
        if (!this._soup) {
            this._usageLastError = 'stopped';
            return null;
        }
        const token = await this._readToken();
        if (!token) {
            this._usageLastError = 'no token';
            return null;
        }
        if (!this._soup) {   // service may have been stopped during the await
            this._usageLastError = 'stopped';
            return null;
        }
        const msg = Soup.Message.new('GET', USAGE_URL);
        const headers = msg.get_request_headers();
        headers.append('Authorization', `Bearer ${token}`);
        headers.append('Accept', 'application/json');
        headers.append('User-Agent', 'claude-usage-gnome');
        let bytes;
        try {
            bytes = await this._soup.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (e) {
            this._usageLastError = 'network error';
            return null;
        }
        // get_status() throws when the HTTP code isn't in the Soup.Status enum (e.g. 429),
        // so read it defensively; recover the numeric code from the error text when possible.
        let status = 200;
        try {
            status = msg.get_status();
        } catch (e) {
            const m = /(\d{3})/.exec(String(e && e.message));
            status = m ? Number(m[1]) : 0;
        }
        if (status !== 200 || !bytes) {
            this._usageLastError = `HTTP ${status || '?'}`;
            return null;
        }
        try {
            const data = JSON.parse(new TextDecoder().decode(bytes.toArray()));
            this._usageLastError = null;
            return data;
        } catch (e) {
            this._usageLastError = 'bad response';
            return null;
        }
    }

    // Real usage from the API (cached ~1/min), with an offline ccusage-style fallback.
    async _getUsage(now, entries, weeklyResetEst) {
        // Attempt the network at most once per USAGE_REFRESH_MS, on success OR failure, so a
        // failing/rate-limited endpoint is never hammered on the 10s refresh tick (hammering
        // is what keeps a 429 alive).
        if ((now - this._usageAttemptedAt) >= USAGE_REFRESH_MS) {
            this._usageAttemptedAt = now;
            const data = await this._fetchUsage();
            if (data) {
                this._usageFetchedAt = now;
                this._usageCache = {
                    fiveHour: windowOf(data.five_hour),
                    sevenDay: windowOf(data.seven_day),
                    sevenDayOpus: windowOf(data.seven_day_opus),
                    sevenDaySonnet: windowOf(data.seven_day_sonnet),
                };
            }
        }

        // Serve the last good API values (marked stale once they age out)...
        if (this._usageCache) {
            const stale = (now - this._usageFetchedAt) >= USAGE_REFRESH_MS * 2;
            return { source: stale ? 'stale' : 'api', ...this._usageCache };
        }

        // ...otherwise fall back to a local estimate from transcripts.
        const ab = activeBlock(computeBlocks(entries, WINDOW_MS), now, WINDOW_MS);
        const fiveHour = ab
            ? { util: Math.min(100, Math.round((ab.tokensUsed / CAP_TOKENS_5H) * 100)), resetMs: ab.resetAt, est: true }
            : null;
        const sevenDay = weeklyResetEst ? { util: null, resetMs: weeklyResetEst, est: true } : null;
        return { source: 'estimate', fiveHour, sevenDay, sevenDayOpus: null, sevenDaySonnet: null };
    }

    // ---- low-level async string read (stream-based, off main loop) ----
    async _loadString(path) {
        const file = Gio.File.new_for_path(path);
        const stream = await file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable);
        try {
            return await drainStream(stream, this._cancellable);
        } finally {
            try { stream.close(null); } catch (e) { /* ignore */ }
        }
    }

    // ---- sessions ----
    async _scanSessions() {
        const dir = Gio.File.new_for_path(SESSIONS_DIR);
        let en;
        try {
            en = await dir.enumerate_children_async(
                'standard::name',
                Gio.FileQueryInfoFlags.NONE,
                GLib.PRIORITY_DEFAULT,
                this._cancellable);
        } catch (e) {
            return [];
        }
        const sessions = [];
        for (;;) {
            const infos = await en.next_files_async(50, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (!infos.length)
                break;
            for (const info of infos) {
                const name = info.get_name();
                if (!name.endsWith('.json'))
                    continue;
                const path = dir.get_child(name).get_path();
                let s;
                try {
                    s = JSON.parse(await this._loadString(path));
                } catch (e) {
                    continue;
                }
                if (!s.pid || !this.isPidAlive(s.pid))
                    continue;
                sessions.push({
                    sessionId: s.sessionId || `pid:${s.pid}`,
                    pid: s.pid,
                    cwd: s.cwd || '',
                    project: s.cwd ? GLib.path_get_basename(s.cwd) : '(unknown)',
                    name: typeof s.name === 'string' ? s.name : '',
                    status: s.status || 'idle',
                    startedAt: s.startedAt || 0,
                });
            }
        }
        en.close(null);
        sessions.sort((a, b) => a.startedAt - b.startedAt);
        return sessions;
    }

    // ---- usage entries (incremental transcript reads) ----
    async _readUsageEntries(now) {
        const candidates = await this._collectCandidates(now);
        for (const c of candidates)
            await this._updateFileCache(c.path, c.size);

        // merge, prune, dedup
        const cutoff = now - ENTRY_RETENTION_MS;
        const seen = new Set();
        const merged = [];
        for (const [, cache] of this._fileCache) {
            if (cache.entries.length) {
                let i = 0;
                while (i < cache.entries.length && cache.entries[i].ts < cutoff)
                    i++;
                if (i > 0)
                    cache.entries.splice(0, i);
            }
            for (const e of cache.entries) {
                if (e.requestId) {
                    if (seen.has(e.requestId))
                        continue;
                    seen.add(e.requestId);
                }
                merged.push(e);
            }
        }
        merged.sort((a, b) => a.ts - b.ts);
        return merged;
    }

    async _collectCandidates(now) {
        const projectsDir = Gio.File.new_for_path(PROJECTS_DIR);
        let projEnum;
        try {
            projEnum = await projectsDir.enumerate_children_async(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                GLib.PRIORITY_DEFAULT,
                this._cancellable);
        } catch (e) {
            return [];
        }
        const horizon = now - WINDOW_MS - 60_000; // small margin
        const out = [];
        for (;;) {
            const projInfos = await projEnum.next_files_async(50, GLib.PRIORITY_DEFAULT, this._cancellable);
            if (!projInfos.length)
                break;
            for (const pInfo of projInfos) {
                if (pInfo.get_file_type() !== Gio.FileType.DIRECTORY)
                    continue;
                const projChild = projectsDir.get_child(pInfo.get_name());
                let fEnum;
                try {
                    fEnum = await projChild.enumerate_children_async(
                        'standard::name,standard::size,time::modified',
                        Gio.FileQueryInfoFlags.NONE,
                        GLib.PRIORITY_DEFAULT,
                        this._cancellable);
                } catch (e) {
                    continue;
                }
                for (;;) {
                    const fInfos = await fEnum.next_files_async(100, GLib.PRIORITY_DEFAULT, this._cancellable);
                    if (!fInfos.length)
                        break;
                    for (const fi of fInfos) {
                        const name = fi.get_name();
                        if (!name.endsWith('.jsonl'))
                            continue;
                        const mt = fi.get_modification_date_time();
                        const mtimeMs = mt ? mt.to_unix() * 1000 : 0;
                        const size = fi.get_size();
                        const path = projChild.get_child(name).get_path();
                        const cached = this._fileCache.get(path);
                        const inWindow = mtimeMs >= horizon;
                        const hasCachedEntries = cached && cached.entries.length > 0;
                        if (!inWindow && !hasCachedEntries)
                            continue;
                        out.push({ path, size });
                    }
                }
                fEnum.close(null);
            }
        }
        projEnum.close(null);
        return out;
    }

    async _updateFileCache(path, size) {
        let cache = this._fileCache.get(path);
        if (!cache) {
            cache = { offset: 0, partial: '', entries: [] };
            this._fileCache.set(path, cache);
        }
        if (size === cache.offset)
            return; // unchanged
        if (size < cache.offset) {
            // truncated / rotated -> start over
            cache.offset = 0;
            cache.partial = '';
            cache.entries = [];
        }

        const file = Gio.File.new_for_path(path);
        let stream;
        try {
            stream = await file.read_async(GLib.PRIORITY_DEFAULT, this._cancellable);
        } catch (e) {
            return;
        }
        try {
            if (cache.offset > 0)
                stream.seek(cache.offset, GLib.SeekType.SET, this._cancellable);
            const text = await drainStream(stream, this._cancellable);
            cache.offset = size;

            for (const line of this._splitLines(cache, text)) {
                const entry = this._parseLine(line);
                if (entry)
                    cache.entries.push(entry);
            }
        } finally {
            try { stream.close(null); } catch (e) { /* ignore */ }
        }
    }

    // Split appended text into complete lines; stash a trailing partial line.
    _splitLines(cache, text) {
        const data = cache.partial + text;
        const lastNL = data.lastIndexOf('\n');
        if (lastNL === -1) {
            cache.partial = data;
            return [];
        }
        cache.partial = data.slice(lastNL + 1);
        return data.slice(0, lastNL).split('\n');
    }

    _parseLine(line) {
        if (!line)
            return null;
        let obj;
        try {
            obj = JSON.parse(line);
        } catch (e) {
            return null;
        }
        if (obj.type !== 'assistant' || obj.isSidechain === true)
            return null;
        const usage = obj.message && obj.message.usage;
        if (!usage)
            return null;
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : NaN;
        if (Number.isNaN(ts))
            return null;
        return {
            ts,
            tokens: sumTokens(usage, COUNT_CACHE_TOKENS),
            model: (obj.message && obj.message.model) || '',
            requestId: obj.requestId || null,
            sessionId: obj.sessionId || null,
        };
    }

    // ---- account: plan tier + (fallback) weekly reset estimate, from ~/.claude.json ----
    async _readAccount() {
        let obj;
        try {
            obj = JSON.parse(await this._loadString(CLAUDE_JSON));
        } catch (e) {
            return { tier: 'Unknown', weeklyResetEst: 0 };
        }
        const acct = obj.oauthAccount || {};
        const rawTier = acct.userRateLimitTier || acct.organizationRateLimitTier ||
            obj.userRateLimitTier || obj.organizationRateLimitTier || '';
        const tier = humanizeTier(rawTier);
        const planEnd = findKey(obj, 'planLimitsEndDate');
        const weeklyResetEst = planEnd ? Date.parse(planEnd) : 0;
        return { tier, weeklyResetEst: Number.isNaN(weeklyResetEst) ? 0 : weeklyResetEst };
    }
}
