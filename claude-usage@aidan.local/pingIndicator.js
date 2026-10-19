/* pingIndicator.js — the pingwatch panel button + Issues dropdown. Pure render from a state.
 *
 * Its own button rather than a section of the usage menu: that menu already runs close
 * to screen height, which squeezed each issue's submenu into a two-row scroll box.
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {
    panelSummary, headerLine, issueActions, statusLabel, formatAgo, needsYou,
} from './pings.js';

const MAX_ISSUES_SHOWN = 10;
const MAX_OTHER_PINGS_SHOWN = 10;

const EMPHASIS_STYLE = {
    alert: 'color: #d21419; font-weight: bold;',   // red — an agent is waiting on you
    active: 'color: #e76125; font-weight: bold;',  // primary orange — open issues
    idle: 'color: #b0b0b0;',
};

export const PingIndicator = GObject.registerClass(
class PingIndicator extends PanelMenu.Button {
    _init(service, extensionPath) {
        super._init(0.0, 'pingwatch Issues');
        this._service = service;

        // ---- compact panel: [chat icon] open-count ----
        this._box = new St.BoxLayout({ style_class: 'panel-status-menu-box claude-panel-box' });
        this._box.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${extensionPath}/icons/pingwatch-chat-symbolic.svg`),
            style_class: 'claude-pico',
            icon_size: 14,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._label = new St.Label({
            style_class: 'claude-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._label);
        this.add_child(this._box);

        // ---- dropdown: header, one submenu per issue, other pings ----
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Issues'));
        this._header = new PopupMenu.PopupMenuItem('', { reactive: false });
        this._header.label.style_class = 'claude-status-line';
        this.menu.addMenuItem(this._header);
        this._issuesSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._issuesSection);
        this._otherPings = new PopupMenu.PopupSubMenuMenuItem('Other pings');
        this.menu.addMenuItem(this._otherPings);

        // Rebuilt only when the snapshot changes, so an open submenu isn't torn down by
        // the periodic refresh, and again on every open so "5m ago" is never stale.
        this._renderedKey = null;
        this._lastPayload = null;
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && this._lastPayload) {
                this._renderedKey = null;
                this.update({ ...this._lastPayload, now: Date.now() });
            }
        });
        this.visible = false;
    }

    update({ state, now }) {
        this._lastPayload = { state, now };
        // No pingwatch on this machine: the button stays out of the panel entirely.
        this.visible = Boolean(state);
        if (!state)
            return;

        const summary = panelSummary(state, now);
        this._label.text = summary.text;
        this._label.style = EMPHASIS_STYLE[summary.emphasis];
        this._header.label.text = headerLine(state, now);

        const key = JSON.stringify([state.issues, state.otherPings]);
        if (key === this._renderedKey)
            return;
        this._renderedKey = key;
        this._renderIssues(state, now);
        this._renderOtherPings(state, now);
    }

    _renderIssues(state, now) {
        this._issuesSection.removeAll();
        const issues = state.issues.slice(0, MAX_ISSUES_SHOWN);
        if (issues.length === 0) {
            this._issuesSection.addMenuItem(new PopupMenu.PopupMenuItem('No open issues', { reactive: false }));
            return;
        }
        for (const issue of issues) {
            // The name is capped and ellipsizes; the status is its own label so it always shows.
            const item = new PopupMenu.PopupSubMenuMenuItem(issue.name);
            item.label.add_style_class_name('pingwatch-issue-label');
            const status = new St.Label({
                text: `·  ${statusLabel(issue.status)}`,
                style_class: 'pingwatch-issue-status',
                y_align: Clutter.ActorAlign.CENTER,
            });
            item.insert_child_above(status, item.label);
            // label_actor is only the name; screen readers should hear the status too
            item.accessible_name = `${issue.name}, ${statusLabel(issue.status)}`;
            if (needsYou(issue)) {
                item.label.style = EMPHASIS_STYLE.alert;
                status.style = EMPHASIS_STYLE.alert;
            }
            if (typeof issue.question === 'string' && issue.question) {
                const question = new PopupMenu.PopupMenuItem(`Asks: ${issue.question}`, { reactive: false });
                question.label.style_class = 'pingwatch-preview';
                question.label.style = EMPHASIS_STYLE.alert;
                question.label.clutter_text.line_wrap = true;
                item.menu.addMenuItem(question);
            }
            for (const action of issueActions(issue))
                item.menu.addMenuItem(this._actionItem(action, issue, state));
            const last = issue.lastPing || {};
            if (last.preview) {
                const when = last.createdAt ? `${formatAgo(now - last.createdAt)}  ` : '';
                const from = last.author ? `@${last.author}: ` : '';
                const preview = new PopupMenu.PopupMenuItem(`${when}${from}${last.preview}`, { reactive: false });
                preview.label.style_class = 'claude-status-line pingwatch-preview';
                preview.label.clutter_text.line_wrap = true;
                item.menu.addMenuItem(preview);
            }
            this._issuesSection.addMenuItem(item);
        }
        if (state.issues.length > MAX_ISSUES_SHOWN) {
            const more = new PopupMenu.PopupMenuItem(
                `… and ${state.issues.length - MAX_ISSUES_SHOWN} more (pingwatch issues)`, { reactive: false });
            more.label.style_class = 'claude-status-line';
            this._issuesSection.addMenuItem(more);
        }
    }

    _renderOtherPings(state, now) {
        this._otherPings.menu.removeAll();
        const others = state.otherPings.slice(0, MAX_OTHER_PINGS_SHOWN);
        this._otherPings.label.text = `Other pings (${state.otherPings.length})`;
        this._otherPings.visible = others.length > 0;
        for (const issue of others) {
            const thread = issueActions(issue).find(action => action.kind === 'url');
            const text = `${issue.kind || '?'} · ${issue.name}`;
            const row = thread
                ? this._actionItem({ ...thread, label: text })
                : new PopupMenu.PopupMenuItem(text, { reactive: false });
            row.label.add_style_class_name('pingwatch-issue-label');
            if (issue.updatedAt) {
                // its own label, like an issue's status: the capped text is what ellipsizes
                const age = new St.Label({
                    text: `·  ${formatAgo(now - issue.updatedAt)}`,
                    style_class: 'pingwatch-issue-status',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                row.insert_child_above(age, row.label);
                row.accessible_name = `${text}, ${age.text.slice(3)}`;
            }
            this._otherPings.menu.addMenuItem(row);
        }
    }

    _actionItem(action, issue = null, state = null) {
        const item = new PopupMenu.PopupMenuItem(action.label);
        item.connect('activate', () => {
            if (action.kind === 'url')
                this._service.openURL(action.url);
            else if (action.kind === 'session')
                this._service.attachSession(action.sessionId);
            else if (action.kind === 'decision')
                this._service.decide(state?.hubSocket, issue.id, action.gate, action.approve);
        });
        return item;
    }
});
