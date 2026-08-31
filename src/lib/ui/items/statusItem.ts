import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import type CopyousExtension from '../../../extension.js';
import { enumParamSpec, registerClass } from '../../common/gjs.js';
import { Icon, loadIcon } from '../../common/icons.js';

export const State = {
	Empty: 0,
	NoResults: 1,
} as const;

export type State = (typeof State)[keyof typeof State];

@registerClass({
	Properties: {
		state: enumParamSpec('state', GObject.ParamFlags.READWRITE, State, State.Empty),
	},
})
export class StatusItem extends St.BoxLayout {
	private _state: State;

	private readonly _emptyIcon: Gio.Icon;
	private readonly _noResultsIcon: Gio.Icon;
	private readonly _icon: St.Icon;
	private readonly _text: St.Label;

	constructor(private ext: CopyousExtension) {
		super({
			style_class: 'clipboard-item status-item',
			orientation: Clutter.Orientation.VERTICAL,
			can_focus: false,
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
			x_expand: true,
			y_expand: true,
		});

		this._state = State.Empty;

		const box = new St.BoxLayout({
			style_class: 'status-item-content',
			x_align: Clutter.ActorAlign.CENTER,
			y_align: Clutter.ActorAlign.CENTER,
			x_expand: true,
			y_expand: true,
			orientation: Clutter.Orientation.VERTICAL,
		});
		this.add_child(box);

		this._emptyIcon = loadIcon(ext, Icon.Clipboard);
		this._noResultsIcon = loadIcon(ext, Icon.SearchClipboard);

		this._icon = new St.Icon({
			style_class: 'status-item-icon',
			gicon: this._emptyIcon,
			x_align: Clutter.ActorAlign.CENTER,
			x_expand: true,
		});
		box.add_child(this._icon);

		this._text = new St.Label({
			style_class: 'status-item-title',
			text: _('Clipboard is Empty'),
			x_align: Clutter.ActorAlign.CENTER,
			x_expand: true,
			y_expand: true,
		});
		this._text.clutter_text.line_wrap = true;
		this._text.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
		box.add_child(this._text);

		// Bind properties
		ext.settings.connectObject(
			'changed::item-width',
			this.updateSize.bind(this),
			'changed::item-height',
			this.updateSize.bind(this),
			this,
		);

		this.updateSize();
	}

	get state(): State {
		return this._state;
	}

	set state(state: State) {
		if (this._state === state) {
			return;
		}

		this._state = state;
		this.notify('state');

		if (this.state === State.Empty) {
			this._icon.gicon = this._emptyIcon;
			this._text.text = _('Clipboard is Empty');
		} else {
			this._icon.gicon = this._noResultsIcon;
			this._text.text = _('No Items Found');
		}
	}

	private updateSize() {
		// The floor is read in the size vfuncs, so only a relayout is needed here.
		this.queue_relayout();
	}

	/**
	 * Clutter requires the natural size to be at least the minimum size, and aborts the whole shell
	 * with `natural width: N < minimum M` when it is not. Setting `min_width` alone left the natural
	 * width at the size of the message, so any item width wider than the text - which is the default -
	 * killed gnome-shell as soon as this item was laid out, i.e. the moment a search matched nothing.
	 *
	 * Raising both values keeps the item at least as large as a clipboard item, while still letting it
	 * grow past that for a long translation instead of ellipsizing the message.
	 */
	override vfunc_get_preferred_width(forHeight: number): [number, number] {
		const [min, natural] = super.vfunc_get_preferred_width(forHeight);
		const floor = this.ext.settings.get_int('item-width');

		return [Math.max(min, floor), Math.max(natural, min, floor)];
	}

	override vfunc_get_preferred_height(forWidth: number): [number, number] {
		const [min, natural] = super.vfunc_get_preferred_height(forWidth);
		const floor = this.ext.settings.get_int('item-height');

		return [Math.max(min, floor), Math.max(natural, min, floor)];
	}

	override destroy() {
		this.ext.settings.disconnectObject(this);

		super.destroy();
	}
}
