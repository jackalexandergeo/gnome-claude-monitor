/* indicator.js — the panel button + dropdown menu. Pure render from a state object. */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

function fmtTokens(n) {
    if (n >= 1e6)
        return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3)
        return `${Math.round(n / 1e3)}k`;
    return String(n);
}

function fmtDuration(ms) {
    if (ms <= 0)
        return 'now';
    const totalMin = Math.floor(ms / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h >= 24) {
        const d = Math.floor(h / 24);
        return `${d}d ${h % 24}h`;
    }
    if (h > 0)
        return `${h}h${String(m).padStart(2, '0')}m`;
    return `${m}m`;
}

function fmtDate(ms) {
    if (!ms)
        return '—';
    const dt = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    return dt.format('%b %d, %H:%M');
}

function bar(pct) {
    const total = 10;
    const filled = Math.max(0, Math.min(total, Math.round((pct / 100) * total)));
    return `[${'█'.repeat(filled)}${'░'.repeat(total - filled)}]`;
}

function fmtAgo(deltaMs) {
    if (deltaMs < 0)
        return 'just now';
    const s = Math.floor(deltaMs / 1000);
    if (s < 60)
        return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
}

export const ClaudeIndicator = GObject.registerClass(
class ClaudeIndicator extends PanelMenu.Button {
    _init(dataService, extensionPath) {
        super._init(0.0, 'Claude Usage');
        this._dataService = dataService;
        this._iconsPath = `${extensionPath}/icons`;
        this._sessionRows = new Map();

        // ---- compact panel: [agents icon] running/total │ [usage icon] %·countdown ----
        this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box claude-panel-box' });

        this._agentIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._iconsPath}/claude-robot-symbolic.svg`),
            style_class: 'claude-pico',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._agentLabel = new St.Label({
            style_class: 'claude-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._sep = new St.Label({
            text: '│',
            style_class: 'claude-vsep',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._usageIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._iconsPath}/claude-gauge-symbolic.svg`),
            style_class: 'claude-pico',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._usageLabel = new St.Label({
            style_class: 'claude-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._box.add_child(this._agentIcon);
        this._box.add_child(this._agentLabel);
        this._box.add_child(this._sep);
        this._box.add_child(this._usageIcon);
        this._box.add_child(this._usageLabel);
        this.add_child(this._box);

        // ---- dropdown: built once, mutated on update ----
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Sessions'));
        this._sessionsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._sessionsSection);
        this._sessionsEmpty = new PopupMenu.PopupMenuItem('No active sessions', { reactive: false });
        this._sessionsSection.addMenuItem(this._sessionsEmpty);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Usage'));
        this._usage5hItem = new PopupMenu.PopupMenuItem('5h block: …', { reactive: false });
        this._weeklyItem = new PopupMenu.PopupMenuItem('Weekly: …', { reactive: false });
        this._tierItem = new PopupMenu.PopupMenuItem('Tier: …', { reactive: false });
        this._todayItem = new PopupMenu.PopupMenuItem('Today: …', { reactive: false });
        this.menu.addMenuItem(this._usage5hItem);
        this.menu.addMenuItem(this._weeklyItem);
        this.menu.addMenuItem(this._tierItem);
        this.menu.addMenuItem(this._todayItem);
        this._statusItem = new PopupMenu.PopupMenuItem('…', { reactive: false });
        this._statusItem.label.style_class = 'claude-status-line';
        this.menu.addMenuItem(this._statusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._dataService.refreshNow());
        this.menu.addMenuItem(refresh);

        this._renderPlaceholder();
    }

    _renderPlaceholder() {
        this._agentLabel.text = '0/0';
        this._usageLabel.text = '…';
    }

    update(state) {
        if (!state || !this._agentLabel)
            return;

        const now = state.now;
        const fh = state.fiveHour;

        // agents: running/total — count turns orange when something is running (icon stays mono)
        const running = state.busyCount;
        const total = state.sessions.length;
        this._agentLabel.text = `${running}/${total}`;
        this._agentLabel.style = running > 0
            ? 'color: #e76125; font-weight: bold;'
            : 'color: #b0b0b0;';

        // usage: %·countdown (no est/stale markers in the collapsed view — see dropdown)
        let pctStr = 'n/a';
        let cd = '--';
        if (fh && fh.util != null) {
            pctStr = `${Math.round(fh.util)}%`;
            cd = fh.resetMs ? fmtDuration(fh.resetMs - now) : '--';
        } else if (fh && fh.resetMs) {
            cd = fmtDuration(fh.resetMs - now);
        }
        this._usageLabel.text = `${pctStr} · ${cd}`;

        this._updateSessions(state);

        // 5-hour window (dropdown keeps the est/stale markers for clarity)
        const star = (state.usageSource === 'estimate' || state.usageSource === 'stale') ? '*' : '';
        if (fh && fh.util != null) {
            const p = Math.round(fh.util);
            this._usage5hItem.label.text =
                `5h: ${bar(p)} ${fh.est ? '~' : ''}${p}%${star} · resets in ${cd}`;
        } else if (fh && fh.resetMs) {
            this._usage5hItem.label.text = `5h: resets in ${fmtDuration(fh.resetMs - now)}`;
        } else {
            this._usage5hItem.label.text = '5h: n/a';
        }

        // weekly window (+ optional model-specific weekly limits)
        const sd = state.sevenDay;
        const parts = [];
        if (sd && sd.util != null)
            parts.push(`${Math.round(sd.util)}%`);
        if (sd && sd.resetMs)
            parts.push(`${fmtDate(sd.resetMs)} (${fmtDuration(sd.resetMs - now)})`);
        const extras = [];
        for (const [key, label] of [['sevenDayOpus', 'opus'], ['sevenDaySonnet', 'sonnet']]) {
            const w = state[key];
            if (w && w.util)
                extras.push(`${label} ${Math.round(w.util)}%`);
        }
        const wk = parts.length ? parts.join('  ') : '—';
        this._weeklyItem.label.text =
            `Weekly: ${wk}${extras.length ? `  ·  ${extras.join(' ')}` : ''}`;

        this._tierItem.label.text = `Tier: ${state.tier}`;
        this._todayItem.label.text = `Today: ${fmtTokens(state.todayTokens)} tok`;

        // last-pull status / error
        if (state.usageError) {
            const ok = state.usageFetchedAt
                ? ` (last ok ${fmtAgo(now - state.usageFetchedAt)})`
                : '';
            this._statusItem.label.text = `⚠ Pull failed: ${state.usageError}${ok}`;
            this._statusItem.label.style = 'color: #d21419;';
        } else if (state.usageFetchedAt) {
            this._statusItem.label.text = `Updated ${fmtAgo(now - state.usageFetchedAt)} · source: ${state.usageSource}`;
            this._statusItem.label.style = '';
        } else {
            this._statusItem.label.text = 'No usage pulled yet…';
            this._statusItem.label.style = '';
        }
    }

    _updateSessions(state) {
        const present = new Set();
        for (const s of state.sessions) {
            present.add(s.sessionId);
            let row = this._sessionRows.get(s.sessionId);
            if (!row) {
                row = this._makeSessionRow();
                this._sessionRows.set(s.sessionId, row);
                this._sessionsSection.addMenuItem(row.item);
            }
            const busy = s.status === 'busy';
            row.dot.style_class = `claude-row-dot ${busy ? 'claude-dot-busy' : 'claude-dot-idle'}`;
            row.dot.text = busy ? '●' : '◌';
            // a named session (`claude -n`, or Claude's own title) reads better than its folder
            row.name.text = s.name || s.project;
            const up = s.startedAt ? fmtDuration(state.now - s.startedAt) : '';
            const tok = s.tokens ? `  ·  ${fmtTokens(s.tokens)} tok` : '';
            row.detail.text = `${s.status}${up ? `  ·  up ${up}` : ''}${tok}`;
        }
        for (const [id, row] of this._sessionRows) {
            if (!present.has(id)) {
                row.item.destroy();
                this._sessionRows.delete(id);
            }
        }
        this._sessionsEmpty.visible = state.sessions.length === 0;
    }

    _makeSessionRow() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const dot = new St.Label({
            text: '◌',
            style_class: 'claude-row-dot claude-dot-idle',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = new St.Label({
            style_class: 'claude-row-name',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const detail = new St.Label({
            style_class: 'claude-row-detail',
            y_align: Clutter.ActorAlign.CENTER,
        });
        item.add_child(dot);
        item.add_child(name);
        item.add_child(detail);
        return { item, dot, name, detail };
    }
});
