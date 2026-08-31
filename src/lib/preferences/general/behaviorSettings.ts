import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Preferences from '../../../prefs.js';
import { registerClass } from '../../common/gjs.js';
import { CopyousSettings, PasteMethod } from '../../common/settings.js';

@registerClass()
export class BehaviorSettings extends Adw.PreferencesGroup {
	private settings: CopyousSettings;

	constructor(prefs: Preferences) {
		super({
			title: _('Behavior'),
		});

		this.settings = prefs.getSettings();

		const rememberSearch = new Adw.SwitchRow({
			title: _('Remember Search Query'),
			subtitle: _('Remember the search query when closing and reopening the clipboard dialog'),
		});
		this.add(rememberSearch);

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

		// Paste method selection
		const pasteMethodRow = new Adw.ComboRow({
			title: _('Auto-Paste Method'),
			subtitle: _('Method used to synthesize keystrokes when pasting clipboard items'),
			model: Gtk.StringList.new([_('Ctrl+V (Recommended)'), _('Shift+Insert (Legacy)'), _('Disabled')]),
		});
		this.add(pasteMethodRow);

		// Bind properties
		this.settings.bind('remember-search', rememberSearch, 'active', Gio.SettingsBindFlags.DEFAULT);
		this.settings.bind('exclude-pinned', excludePinned, 'active', Gio.SettingsBindFlags.DEFAULT);
		this.settings.bind('exclude-tagged', excludeTagged, 'active', Gio.SettingsBindFlags.DEFAULT);
		this.settings.bind('protect-pinned', protectPinned, 'active', Gio.SettingsBindFlags.DEFAULT);
		this.settings.bind('protect-tagged', protectTagged, 'active', Gio.SettingsBindFlags.DEFAULT);
		this.settings.bind('sync-primary', syncPrimary, 'active', Gio.SettingsBindFlags.DEFAULT);
		this.settings.bind('update-date-on-copy', updateDateOnCopy, 'active', Gio.SettingsBindFlags.DEFAULT);

		// Bind paste method (enum 0-2)
		this.settings.connectObject(
			'changed::paste-method',
			() => pasteMethodRow.set_selected(this.settings.get_enum('paste-method')),
			this,
		);
		const signalId = pasteMethodRow.connect('notify::selected', () => {
			this.settings.set_enum('paste-method', pasteMethodRow.selected as PasteMethod);
		});
		pasteMethodRow.set_selected(this.settings.get_enum('paste-method'));

		// Cleanup signal handler when the widget is destroyed
		this.connectObject(
			'destroy',
			() => {
				pasteMethodRow.disconnect(signalId);
				this.settings.disconnectObject(this);
			},
			this,
		);
	}
}
