/* prefs.js — preferences: where in the top bar the indicator lives. */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { BOXES, BOX_TITLES } from './placement.js';

export default class ClaudeUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: 'Top-bar placement',
            description: 'Where the Claude indicator appears in the top bar',
        });
        page.add(group);

        // Box (left / center / right / middle of the left half)
        const boxRow = new Adw.ComboRow({
            title: 'Section',
            subtitle: 'Which part of the top bar',
        });
        boxRow.model = new Gtk.StringList({ strings: BOX_TITLES });
        boxRow.selected = Math.max(0, BOXES.indexOf(settings.get_string('panel-box')));
        boxRow.connect('notify::selected', () => {
            settings.set_string('panel-box', BOXES[boxRow.selected]);
        });
        group.add(boxRow);

        // Position within the box
        const posRow = new Adw.SpinRow({
            title: 'Position',
            subtitle: 'Index within the section (0 = first)',
            adjustment: new Gtk.Adjustment({
                lower: 0, upper: 20, step_increment: 1, page_increment: 1,
            }),
        });
        posRow.value = settings.get_int('panel-position');
        posRow.connect('notify::value', () => {
            const v = Math.round(posRow.value);
            if (v !== settings.get_int('panel-position'))
                settings.set_int('panel-position', v);
        });
        settings.connect('changed::panel-position', () => {
            posRow.value = settings.get_int('panel-position');
        });
        group.add(posRow);

        window.add(page);
    }
}
