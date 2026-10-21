/* extension.js — lifecycle orchestrator. Holds no module-level mutable state. */

import GLib from 'gi://GLib';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { DataService } from './dataService.js';
import { ClaudeIndicator } from './indicator.js';
import { PingIndicator } from './pingIndicator.js';
import { PingService } from './pingService.js';
import { BannerBook, NOTIFICATION_KINDS, notificationTitle } from './pings.js';
import { leftHalfMargin, shellBox } from './placement.js';

const BOX_ACTORS = {
    left: () => Main.panel._leftBox,
    center: () => Main.panel._centerBox,
    right: () => Main.panel._rightBox,
};

export default class ClaudeUsageExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._lastState = null;

        this._dataService = new DataService();
        this._indicator = new ClaudeIndicator(this._dataService, this.path);
        // Register once: places it and wires up the menu with the panel's menu manager.
        Main.panel.addToStatusArea(
            this.uuid, this._indicator,
            this._settings.get_int('panel-position'),
            shellBox(this._settings.get_string('panel-box')));

        // Keep the latest state so a re-position can repaint immediately.
        this._dataService.connect(state => {
            this._lastState = state;
            this._indicator?.update(state);
        });

        // pingwatch Issues: a button of its own, hidden unless pingwatch runs on this machine.
        this._pingService = new PingService();
        this._pingIndicator = new PingIndicator(this._pingService, this.path,
            (title, body) => this._notify({ kind: 'problem', title: notificationTitle('problem', title), body, url: null,
                pending: [] }));
        this._banners = new BannerBook();   // each issue's newest needs-you notification
        Main.panel.addToStatusArea(`${this.uuid}-pings`, this._pingIndicator);
        this._placePingIndicator();
        this._pingService.connect(payload => {
            this._pingIndicator?.update(payload);
            for (const notification of payload.notifications)
                this._notify(notification);
        });

        this._settingsChangedId = this._settings.connect('changed', () => this._reposition());
        // In the middle of the left half, the margin follows the bar's and the buttons' widths.
        this._widthWatches = [Main.panel, this._indicator.container, this._pingIndicator.container]
            .map(actor => [actor, actor.connect('notify::width', () => this._queueCentering())]);
        this._queueCentering();

        this._dataService.start();
        this._pingService.start();
    }

    disable() {
        for (const [actor, id] of this._widthWatches ?? [])
            actor.disconnect(id);
        this._widthWatches = null;
        if (this._centeringId) {
            GLib.source_remove(this._centeringId);
            this._centeringId = 0;
        }
        this._indicator?.container.set_style(null);
        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }
        this._settings = null;
        this._lastState = null;

        // Stop the engine (removes timers/monitors/in-flight reads) before destroying
        // the actor it pushes state into.
        this._dataService?.stop();
        this._dataService = null;
        this._pingService?.stop();
        this._pingService = null;
        // Explicit: Source.destroy() without a reason destroys each notification as DISMISSED,
        // which would read as the user having dismissed everything on every lock.
        this._notificationSource?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._notificationSource = null;
        this._banners = null;
        this._pingIndicator?.destroy();
        this._pingIndicator = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    // One source for every pingwatch notification. The shell destroys a source once its
    // last notification is gone, so it is recreated on demand.
    _notify({ kind, title, body, url, pending }) {
        if (!this._pingService)
            return;   // disabled: nothing may outlive disable(), not even a new source
        const ids = (pending ?? []).map(item => item.id);
        // Before adding, or a superseded banner holds a queue or per-source slot the new one needs.
        // REPLACED is not a dismissal, so nothing is acknowledged by it.
        for (const banner of this._banners.superseded(ids)) {
            if (this._notificationSource?.notifications.includes(banner))
                banner.destroy(MessageTray.NotificationDestroyedReason.REPLACED);
        }
        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({ title: 'pingwatch', iconName: 'mail-unread-symbolic' });
            this._notificationSource.connect('destroy', () => {
                this._notificationSource = null;
            });
            Main.messageTray.add(this._notificationSource);
        }
        const look = NOTIFICATION_KINDS[kind] ?? NOTIFICATION_KINDS.new;
        const notification = new MessageTray.Notification({
            source: this._notificationSource, title, body, iconName: look.icon,
            urgency: look.urgent ? MessageTray.Urgency.HIGH : MessageTray.Urgency.NORMAL,
        });
        this._banners.record(notification, ids);
        if (url)
            notification.connect('activated', () => this._pingService?.openURL(url));
        // Only the user's own dismissal (or click) settles a needs-you. Cleared by a lock or a
        // disable (SOURCE_CLOSED), it is raised again next time if the issue still needs them.
        notification.connect('destroy', (_notification, reason) => {
            this._banners?.forget(notification);
            if (reason === MessageTray.NotificationDestroyedReason.DISMISSED)
                this._pingService?.acknowledge(pending ?? []);
        });
        this._notificationSource.addNotification(notification);
    }

    // Keep the Issues button right after the usage indicator, wherever that sits.
    _placePingIndicator() {
        const anchor = this._indicator?.container;
        const container = this._pingIndicator?.container;
        if (!anchor || !container || !anchor.get_parent())
            return;
        container.get_parent()?.remove_child(container);
        anchor.get_parent().insert_child_above(container, anchor);
    }

    // Move the existing indicator to the configured box/position without re-registering
    // (which would throw on the duplicate role and lose the menu wiring).
    _reposition() {
        if (!this._indicator || !this._settings)
            return;
        // The Issues button follows the usage one; out of the box while placing, or it is
        // counted and indexed as a neighbour and a one-step move is swallowed.
        const pingContainer = this._pingIndicator?.container;
        pingContainer?.get_parent()?.remove_child(pingContainer);

        const container = this._indicator.container;
        const parent = container.get_parent();
        if (parent)
            parent.remove_child(container);

        const boxName = this._settings.get_string('panel-box');
        const target = BOX_ACTORS[shellBox(boxName)]();
        const count = target.get_n_children();
        const pos = Math.max(0, Math.min(this._settings.get_int('panel-position'), count));
        target.insert_child_at_index(container, pos);
        this._placePingIndicator();
        this._centerInLeftHalf();
        this._queueCentering();   // again once the new place has its widths
    }

    _queueCentering() {
        if (this._centeringId)
            return;
        this._centeringId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._centeringId = 0;
            this._centerInLeftHalf();
            return GLib.SOURCE_REMOVE;
        });
    }

    // GNOME gives the left box only the width of what it holds, so in the middle of the left
    // half the buttons are pushed right by a margin on the first of them. Anywhere else: none.
    _centerInLeftHalf() {
        const container = this._indicator?.container;
        const parent = container?.get_parent();
        if (!parent || !this._settings)
            return;
        let margin = 0;
        if (this._settings.get_string('panel-box') === 'left-middle') {
            let widthBefore = 0;
            for (const child of parent.get_children()) {
                if (child === container)
                    break;
                if (child.visible)
                    widthBefore += child.width;
            }
            const issues = this._pingIndicator?.container;
            const ownWidth = container.width + (issues?.visible ? issues.width : 0);
            margin = leftHalfMargin(Main.panel.width, widthBefore, ownWidth);
        }
        container.set_style(margin ? `margin-left: ${margin}px;` : null);
    }
}
