/* extension.js — lifecycle orchestrator. Holds no module-level mutable state. */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import { DataService } from './dataService.js';
import { ClaudeIndicator } from './indicator.js';
import { PingIndicator } from './pingIndicator.js';
import { PingService } from './pingService.js';

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
            this._settings.get_string('panel-box'));

        // Keep the latest state so a re-position can repaint immediately.
        this._dataService.connect(state => {
            this._lastState = state;
            this._indicator?.update(state);
        });

        // pingwatch Issues: a button of its own, hidden unless pingwatch runs on this machine.
        this._pingService = new PingService();
        this._pingIndicator = new PingIndicator(this._pingService, this.path);
        Main.panel.addToStatusArea(`${this.uuid}-pings`, this._pingIndicator);
        this._placePingIndicator();
        this._pingService.connect(payload => {
            this._pingIndicator?.update(payload);
            for (const notification of payload.notifications)
                this._notify(notification);
        });

        this._settingsChangedId = this._settings.connect('changed', () => this._reposition());

        this._dataService.start();
        this._pingService.start();
    }

    disable() {
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
        this._notificationSource?.destroy();
        this._notificationSource = null;
        this._pingIndicator?.destroy();
        this._pingIndicator = null;
        this._indicator?.destroy();
        this._indicator = null;
    }

    // One source for every pingwatch notification. The shell destroys a source once its
    // last notification is dismissed, so it is recreated on demand.
    _notify({ title, body, url }) {
        if (!this._notificationSource) {
            this._notificationSource = new MessageTray.Source({ title: 'pingwatch', iconName: 'mail-unread-symbolic' });
            this._notificationSource.connect('destroy', () => {
                this._notificationSource = null;
            });
            Main.messageTray.add(this._notificationSource);
        }
        const notification = new MessageTray.Notification({ source: this._notificationSource, title, body });
        if (url)
            notification.connect('activated', () => this._pingService?.openURL(url));
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
        const target = (BOX_ACTORS[boxName] || BOX_ACTORS.right)();
        const count = target.get_n_children();
        const pos = Math.max(0, Math.min(this._settings.get_int('panel-position'), count));
        target.insert_child_at_index(container, pos);
        this._placePingIndicator();
    }
}
