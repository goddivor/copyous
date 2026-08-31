import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Preferences from '../../../prefs.js';
import { registerClass } from '../../common/gjs.js';
import { CopyousSettings, bind_enum } from '../../common/settings.js';
import { makeResettable } from '../utils.js';
import { ShortcutRow } from './shortcutRow.js';

@registerClass()
export class SearchShortcuts extends Adw.PreferencesGroup {
	constructor(prefs: Preferences) {
		super({ title: _('Search') });

		const togglePinnedSearchRow = new ShortcutRow(_('Toggle Pinned Search'), '<Alt>', true);
		this.add(togglePinnedSearchRow);
		this.add(new ShortcutRow(_('Clear Item Tag/Type'), 'Back'));
		this.add(new ShortcutRow(_('Activate First Item'), 'Return'));

		// Bind properties
		const settings: CopyousSettings = prefs.getSettings();
		settings.bind('toggle-pinned-search-shortcut', togglePinnedSearchRow, 'shortcuts', null);
	}
}

@registerClass()
export class SearchNavigationShortcuts extends Adw.PreferencesGroup {
	constructor() {
		super();

		this.add(new ShortcutRow(_('Next Item Type'), '<Ctrl>Tab'));
		this.add(new ShortcutRow(_('Previous Item Type'), '<Ctrl><Shift>Tab'));
		this.add(new ShortcutRow(_('Next Item Tag'), '<Ctrl>grave'));
		this.add(new ShortcutRow(_('Previous Item Tag'), '<Ctrl><Shift>grave'));
		this.add(new ShortcutRow(_('Select Item Tag'), '<Ctrl><Shift>0...9'));
	}
}

@registerClass()
export class SearchScrollShortcuts extends Adw.PreferencesGroup {
	constructor(prefs: Preferences) {
		super();

		const modifiers = () =>
			Gtk.StringList.new([
				_('Scroll'),
				_('Ctrl + Scroll'),
				_('Alt + Scroll'),
				_('Shift + Scroll'),
				_('Super + Scroll'),
			]);

		const cycleItemType = new Adw.ComboRow({
			title: _('Cycle Item Type'),
			subtitle: _('Modifier held with the scroll wheel to cycle through item types'),
			model: modifiers(),
		});
		this.add(cycleItemType);

		const cycleItemTag = new Adw.ComboRow({
			title: _('Cycle Item Tag'),
			subtitle: _('Modifier held with the scroll wheel to cycle through item tags'),
			model: modifiers(),
		});
		this.add(cycleItemTag);

		// Bind properties
		const settings: CopyousSettings = prefs.getSettings();
		bind_enum(settings, 'cycle-item-type-scroll-modifier', cycleItemType, 'selected');
		bind_enum(settings, 'cycle-item-tag-scroll-modifier', cycleItemTag, 'selected');

		makeResettable(cycleItemType, settings, 'cycle-item-type-scroll-modifier');
		makeResettable(cycleItemTag, settings, 'cycle-item-tag-scroll-modifier');
	}
}
