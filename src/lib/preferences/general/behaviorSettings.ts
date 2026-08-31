import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Preferences from '../../../prefs.js';
import { registerClass } from '../../common/gjs.js';
import { CopyousSettings, bind_enum } from '../../common/settings.js';

@registerClass()
export class BehaviorSettings extends Adw.PreferencesGroup {
	constructor(prefs: Preferences) {
		super({
			title: _('Behavior'),
		});

		const rememberSearch = new Adw.SwitchRow({
			title: _('Remember Search Query'),
			subtitle: _('Remember the search query when closing and reopening the clipboard dialog'),
		});
		this.add(rememberSearch);

		const pinnedOnTop = new Adw.SwitchRow({
			title: _('Keep Pinned Items on Top'),
			subtitle: _('Pin items appear at the top of the clipboard history list'),
		});
		this.add(pinnedOnTop);

		const excludePinned = new Adw.SwitchRow({
			title: _('Exclude Pinned Items from Main View'),
			subtitle: _('Pinned items appear only when searching for pinned items'),
		});
		this.add(excludePinned);

		const excludeTagged = new Adw.SwitchRow({
			title: _('Exclude Tagged Items from Main View'),
			subtitle: _('Tagged items appear only when searching for tagged items'),
		});
		this.add(excludeTagged);

		const protectPinned = new Adw.SwitchRow({
			title: _('Protect Pinned Items'),
			subtitle: _('Prevents pinned clipboard items from being deleted'),
		});
		this.add(protectPinned);

		const protectTagged = new Adw.SwitchRow({
			title: _('Protect Tagged Items'),
			subtitle: _('Prevents tagged clipboard items from being deleted'),
		});
		this.add(protectTagged);

		const syncPrimary = new Adw.SwitchRow({
			title: _('Sync Primary Clipboard'),
			subtitle: _('Also copy clipboard items to the primary clipboard'),
		});
		this.add(syncPrimary);

		const updateDateOnCopy = new Adw.SwitchRow({
			title: _('Update Date on Copy'),
			subtitle: _('Update the copied date of clipboard items when selected from clipboard history'),
		});
		this.add(updateDateOnCopy);

		const pasteMethod = new Adw.ComboRow({
			title: _('Auto-Paste Method'),
			subtitle: _('Keys sent to paste the selected item into the focused application'),
			model: Gtk.StringList.new([_('Ctrl+V'), _('Shift+Insert'), _('Disabled')]),
		});
		this.add(pasteMethod);

		// Bind properties
		const settings: CopyousSettings = prefs.getSettings();
		settings.bind('remember-search', rememberSearch, 'active', Gio.SettingsBindFlags.DEFAULT);
		settings.bind('pinned-on-top', pinnedOnTop, 'active', Gio.SettingsBindFlags.DEFAULT);
		settings.bind('exclude-pinned', excludePinned, 'active', Gio.SettingsBindFlags.DEFAULT);
		settings.bind('exclude-tagged', excludeTagged, 'active', Gio.SettingsBindFlags.DEFAULT);
		settings.bind('protect-pinned', protectPinned, 'active', Gio.SettingsBindFlags.DEFAULT);
		settings.bind('protect-tagged', protectTagged, 'active', Gio.SettingsBindFlags.DEFAULT);
		settings.bind('sync-primary', syncPrimary, 'active', Gio.SettingsBindFlags.DEFAULT);
		settings.bind('update-date-on-copy', updateDateOnCopy, 'active', Gio.SettingsBindFlags.DEFAULT);
		bind_enum(settings, 'paste-method', pasteMethod, 'selected');
	}
}
