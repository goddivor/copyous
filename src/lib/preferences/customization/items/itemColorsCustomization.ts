import Adw from 'gi://Adw';

import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import Preferences from '../../../../prefs.js';
import { Color } from '../../../common/color.js';
import { registerClass } from '../../../common/gjs.js';
import { CopyousSettings, ItemColorKey, ItemColorsSettings, Settings } from '../../../common/settings.js';
import { makeResettable } from '../../utils.js';
import { ColorRow } from '../themeCustomization.js';

/** An unset item color is shown as fully transparent, which is also how it is cleared again. */
const NoColor = 'rgba(0,0,0,0)';

const ItemColorRows: [ItemColorKey, string][] = [
	[Settings.ItemColors.Text, _('Text')],
	[Settings.ItemColors.Code, _('Code')],
	[Settings.ItemColors.Image, _('Image')],
	[Settings.ItemColors.File, _('File')],
	[Settings.ItemColors.Files, _('Files')],
	[Settings.ItemColors.Link, _('Link')],
	[Settings.ItemColors.Character, _('Character')],
	[Settings.ItemColors.Color, _('Color')],
];

function bind_item_color(settings: ItemColorsSettings, key: ItemColorKey, target: ColorRow) {
	function setColor() {
		target.color = settings.get_string(key) || NoColor;
	}

	function getColor() {
		// A fully transparent color means no color at all, which is stored as the empty default so
		// that the reset button of the row stays in sync with what is shown.
		const color = Color.parse(target.color);
		settings.set_string(key, !color || color.alpha === 0 ? '' : target.color);
	}

	setColor();
	settings.connect(`changed::${key}`, setColor);
	target.connect('notify::color', getColor);
}

@registerClass()
export class ItemColorsCustomization extends Adw.ExpanderRow {
	constructor(prefs: Preferences) {
		super({
			title: _('Item Colors'),
			subtitle: _('Color clipboard items by type to tell them apart at a glance'),
		});

		const settings = (prefs.getSettings() as CopyousSettings).get_child('item-colors');

		for (const [key, title] of ItemColorRows) {
			const row = new ColorRow({ title });
			this.add_row(row);

			bind_item_color(settings, key, row);
			makeResettable(row, settings, key);
		}
	}
}
