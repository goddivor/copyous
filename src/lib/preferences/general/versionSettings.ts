import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Preferences from '../../../prefs.js';
import { registerClass } from '../../common/gjs.js';

@registerClass()
export class VersionSettings extends Adw.PreferencesGroup {
	constructor(prefs: Preferences, window: Adw.PreferencesWindow) {
		super({
			title: _('About'),
		});

		// `metadata` is loosely typed, so narrow the two fields that hold a version before using them.
		const metadata = prefs.metadata as { 'version-name'?: string; 'version'?: number };
		const version = metadata['version-name'] ?? metadata.version?.toString() ?? _('Unknown');

		const row = new Adw.ActionRow({
			title: _('Installed Version'),
			subtitle: version,
			subtitle_selectable: true,
		});

		const copyButton = new Gtk.Button({
			icon_name: 'edit-copy-symbolic',
			valign: Gtk.Align.CENTER,
			css_classes: ['flat'],
			tooltip_text: _('Copy Version'),
		});
		copyButton.connect('clicked', () => {
			window.get_display().get_clipboard().set(version);
			window.add_toast(new Adw.Toast({ title: _('Copied to Clipboard') }));
		});

		row.add_suffix(copyButton);
		row.activatable_widget = copyButton;

		this.add(row);
	}
}
