import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import type CopyousExtension from '../../../extension.js';
import { ActiveState } from '../../common/constants.js';
import { flagsParamSpec, registerClass } from '../../common/gjs.js';
import { Icon } from '../../common/icons.js';
import { MiddleClickAction } from '../../common/settings.js';
import { ClipboardEntry } from '../../database/database.js';
import { VERSION } from '../../misc/compatibility.js';
import { Shortcut } from '../../misc/shortcuts.js';
import { SearchQuery } from '../searchEntry.js';
import { ClipboardItemHeader } from './clipboardItemHeader.js';

@registerClass({
	Properties: {
		entry: GObject.ParamSpec.object('entry', null, null, GObject.ParamFlags.READABLE, ClipboardEntry),
		active: flagsParamSpec('active', GObject.ParamFlags.READABLE, ActiveState, ActiveState.None),
	},
	Signals: {
		'activate': {},
		'activate-shift': {},
		'activate-ctrl': {},
		'activate-action': { param_types: [GObject.TYPE_STRING] },
		'edit': {},
		'open-menu': { param_types: [GObject.TYPE_INT, GObject.TYPE_INT, GObject.TYPE_INT, GObject.TYPE_INT] },
	},
})
export class ClipboardItem extends St.Button {
	private _protectPinned: boolean = true;
	private _protectTagged: boolean = true;
	private _middleClickAction: MiddleClickAction = MiddleClickAction.None;

	private readonly _box: St.Widget;
	private readonly _header: ClipboardItemHeader;
	protected _content: St.BoxLayout;

	constructor(
		protected ext: CopyousExtension,
		readonly entry: ClipboardEntry,
		icon: Icon,
		title: string,
	) {
		super({
			style_class: 'clipboard-item',
			button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
			x_expand: false,
			y_expand: false,
			track_hover: true,
			can_focus: true,
			width: 300,
			height: 200,
		});

		this._box = new St.Widget({
			style_class: 'clipboard-item-box',
			x_expand: true,
			y_expand: true,
			layout_manager: new Clutter.BoxLayout({ orientation: Clutter.Orientation.VERTICAL }),
		});
		this.set_child(this._box);

		this._header = new ClipboardItemHeader(ext, icon, title);
		this._box.add_child(this._header);

		this._content = new St.BoxLayout({
			style_class: 'clipboard-item-content',
			orientation: Clutter.Orientation.VERTICAL,
			x_expand: true,
			y_expand: true,
			clip_to_allocation: true,
			effect: HoleEffect(this._header.buttons),
		});
		this._box.add_child(this._content);

		// Bind properties
		entry.bind_property(
			'pinned',
			this._header,
			'pinned',
			GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE,
		);
		entry.bind_property('datetime', this._header, 'datetime', GObject.BindingFlags.SYNC_CREATE);
		entry.bind_property('tag', this._header, 'tag', GObject.BindingFlags.SYNC_CREATE);
		entry.bind_property(
			'title',
			this._header,
			'custom-title',
			GObject.BindingFlags.BIDIRECTIONAL | GObject.BindingFlags.SYNC_CREATE,
		);

		// prettier-ignore
		this.ext.settings.connectObject(
			'changed::item-width', this.updateSize.bind(this),
			'changed::item-height', this.updateSize.bind(this),
			'changed::dynamic-item-height', this.updateSize.bind(this),
			'changed::clipboard-orientation', this.updateSize.bind(this),
			'changed::protect-pinned', this.updateProtection.bind(this),
			'changed::protect-tagged', this.updateProtection.bind(this),
			'changed::middle-click-action', this.updateMiddleClickAction.bind(this),
			'changed::show-header', this.updateHeader.bind(this),
			'changed::show-item-title', this.updateHeader.bind(this),
			'changed::header-controls-visibility', this.updateHeader.bind(this),
			this);

		this.bind_property('active', this._header, 'active', GObject.BindingFlags.SYNC_CREATE);
		this.ext.shortcutsManager?.bind_property(
			'shift',
			this._header,
			'force-delete',
			GObject.BindingFlags.SYNC_CREATE,
		);

		this.updateSize();
		this.updateProtection();
		this.updateMiddleClickAction();
		this.updateHeader();

		// Connect signals
		this.connect('notify::hover', () => this.notify('active'));
		this.connect('style-changed', () => this.notify('active'));
		this._header.connect('delete', () => this.forceDelete());
		this._header.connect('open-menu', (_, x, y, w, h) => this.emit('open-menu', x, y, w, h));
		this._header.connect('editing-finished', () => this.grab_key_focus());
	}

	get active(): ActiveState {
		this.sync_hover();
		const focus = +this.has_key_focus() * ActiveState.Focus;
		const hover = +this.hover * ActiveState.Hover;
		const active = +(this.get_style_pseudo_class()?.includes('active') ?? false) * ActiveState.Active;
		return (focus | hover | active) as ActiveState;
	}

	public search(query: SearchQuery) {
		this.visible = query.matchesEntry(this.visible, this.entry, this.entry.content);
	}

	private updateSize() {
		const width = this.ext.settings.get_int('item-width');
		const height = this.ext.settings.get_int('item-height');
		this.set_size(width, height);

		const dynamicHeight = this.ext.settings.get_boolean('dynamic-item-height');
		const orientation = this.ext.settings.get_enum('clipboard-orientation');
		if (dynamicHeight && orientation === Clutter.Orientation.VERTICAL) {
			this.set_height(-1);
			this.style = `max-height: ${height}px`;
		} else {
			this.style = '';
		}
	}

	private updateProtection() {
		this._protectPinned = this.ext.settings.get_boolean('protect-pinned');
		this._protectTagged = this.ext.settings.get_boolean('protect-tagged');
		this._header.protectPinned = this._protectPinned;
		this._header.protectTagged = this._protectTagged;
	}

	private updateMiddleClickAction() {
		this._middleClickAction = this.ext.settings.get_enum('middle-click-action');
		if (this._middleClickAction === MiddleClickAction.None) {
			this.button_mask &= ~St.ButtonMask.TWO;
		} else {
			this.button_mask |= St.ButtonMask.TWO;
		}
	}

	private updateHeader() {
		const show = this.ext.settings.get_boolean('show-header');
		this._header.headerVisible = show;
		this._header.showTitle = this.ext.settings.get_boolean('show-item-title');
		this._header.controlsVisibility = this.ext.settings.get_enum('header-controls-visibility');

		if (show) {
			this.remove_style_class_name('no-header');
			this._box.set_child_above_sibling(this._content, this._header);
			this._box.layout_manager = new Clutter.BoxLayout({ orientation: Clutter.Orientation.VERTICAL });
		} else {
			this.add_style_class_name('no-header');
			this._box.set_child_above_sibling(this._header, this._content);
			this._box.layout_manager = new Clutter.BinLayout();
		}
	}

	private delete() {
		if (!(this._protectPinned && this.entry.pinned) && !(this._protectTagged && this.entry.tag)) {
			this.entry.emit('delete');
		}
	}

	private forceDelete() {
		this.entry.emit('delete');
	}

	override vfunc_clicked(clicked_button: number): void {
		// Don't activate while editing the title
		if (this._header.isEditing) return;

		if (clicked_button === 1) {
			const event = Clutter.get_current_event();
			if (event.has_control_modifier()) {
				this.emit('activate-ctrl');
			} else if (event.has_shift_modifier()) {
				this.emit('activate-shift');
			} else {
				this.emit('activate');
			}
		} else if (clicked_button === 2) {
			if (this._middleClickAction === MiddleClickAction.Pin) {
				this.entry.pinned = !this.entry.pinned;
			} else if (this._middleClickAction === MiddleClickAction.Delete) {
				const event = Clutter.get_current_event();
				if (event.has_shift_modifier()) {
					this.forceDelete();
				} else {
					this.delete();
				}
			}
		} else if (clicked_button === 3) {
			const [x, y] = global.get_pointer();
			this.emit('open-menu', x, y, 0, 0);
			this.fake_release();
		}
	}

	override vfunc_key_focus_in(): void {
		super.vfunc_key_focus_in();
		this.notify('active');
	}

	override vfunc_key_focus_out(): void {
		super.vfunc_key_focus_out();
		this.notify('active');
	}

	override vfunc_key_press_event(event: Clutter.Event): boolean {
		const key = event.get_key_symbol();
		const action = this.ext.shortcutsManager?.getShortcutForKeyBinding(key, event.get_state());

		const shiftState = event.get_state() & ~Clutter.ModifierType.SHIFT_MASK;
		const shiftAction = this.ext.shortcutsManager?.getShortcutForKeyBinding(key, shiftState);

		// Pin
		if (action === Shortcut.Pin) {
			this.entry.pinned = !this.entry.pinned;
			return Clutter.EVENT_STOP;
		}

		// Delete
		if (action === Shortcut.Delete) {
			this.delete();
			return Clutter.EVENT_STOP;
		}

		// Force Delete
		if (shiftAction === Shortcut.Delete) {
			this.forceDelete();
			return Clutter.EVENT_STOP;
		}

		// Edit
		if (action === Shortcut.Edit) {
			this.emit('edit');
			return Clutter.EVENT_STOP;
		}

		// Edit Title
		if (action === Shortcut.EditTitle) {
			this._header.startEditing();
			return Clutter.EVENT_STOP;
		}

		// Menu
		if (action === Shortcut.Menu) {
			const [x, y] = this.get_transformed_position();
			this.emit('open-menu', x + 6, y, 0, 0);
			return Clutter.EVENT_STOP;
		}

		// Action
		const actionId = this.ext.shortcutsManager?.getActionForKeyBinding(key, event.get_state());
		if (actionId) this.emit('activate-action', actionId);

		return super.vfunc_key_press_event(event);
	}

	override vfunc_get_preferred_height(for_width: number): [number, number] {
		const theme = this.get_theme_node();
		const border = theme.get_border_width(St.Side.TOP) + theme.get_border_width(St.Side.BOTTOM);
		const maxHeight = theme.get_max_height();

		const [, nat] = this._box.get_preferred_height(for_width);
		const height = Math.min(nat + border, maxHeight);
		return [height, height];
	}

	override destroy() {
		this.ext.settings.disconnectObject(this);

		super.destroy();
	}
}

const HOLE_SHADER_FUNCTIONS = `
	float circle_bounds(vec2 p, vec2 center, float radius) {
		vec2 delta = p - center;
		float dist_squared = dot(delta, delta);
		float dist = sqrt(dist_squared);

		float outer_radius = radius + 0.5;
		if (dist >= outer_radius)
			return 1.0;

		float inner_radius = radius - 0.5;
		if (dist <= inner_radius)
			return 0.0;

		return dist - inner_radius;
	}

	float rounded_rect_coverage(vec2 p, vec4 bounds, float radius) {
		if (p.x < bounds.x || p.x > bounds.z || p.y < bounds.y || p.y > bounds.w)
			return 1.0;

		vec2 center;

		float center_left = bounds.x + radius;
		float center_right = bounds.z - radius;

		if (p.x < center_left)
			center.x = center_left;
		else if (p.x > center_right)
			center.x = center_right;
		else
			return 0.0;

		center.y = bounds.y + radius;

		return circle_bounds(p, center, radius);
	}`;

const HOLE_SHADER_BODY = `
	vec2 uv = cogl_tex_coord_in[0].xy;
	vec2 p = size * cogl_tex_coord_in[0].xy;
	vec4 c = cogl_color_in * texture2D(tex, uv);

	if (hole_box.z <= 2.0 || hole_box.w <= 2.0) {
		cogl_color_out = c;
		return;
	}

	float radius = hole_box.w / 2.0;
	vec4 bounds = vec4(hole_box.x, hole_box.y, hole_box.x + hole_box.z, hole_box.y + hole_box.w);
	float alpha = rounded_rect_coverage(p, bounds, radius);
	cogl_color_out = vec4(c.rgb * alpha, min(alpha, c.a));`;

const GLSL_HOLE_SHADER_DECLARATIONS = `
	uniform sampler2D tex;
	uniform vec2 size;
	uniform vec4 hole_box;
	${HOLE_SHADER_FUNCTIONS}`;

// Clutter.ShaderEffect can only set uniforms through a GValue, and the boxed ClutterShaderFloat
// type that vector uniforms require cannot be constructed from GJS. Scalar float uniforms can,
// so the vectors are passed component by component and reassembled in the shader.
const SHADER_HOLE_SHADER_DECLARATIONS = `
	uniform sampler2D tex;
	uniform float size_x;
	uniform float size_y;
	uniform float hole_x;
	uniform float hole_y;
	uniform float hole_width;
	uniform float hole_height;
	${HOLE_SHADER_FUNCTIONS}`;

const SHADER_HOLE_SHADER_BODY = `
	vec2 size = vec2(size_x, size_y);
	vec4 hole_box = vec4(hole_x, hole_y, hole_width, hole_height);
	${HOLE_SHADER_BODY}`;

interface HoleEffectConstructor {
	new (target: Clutter.Actor): Clutter.Effect;
}

function holeBox(effect: Clutter.OffscreenEffect, target: Clutter.Actor): [number, number, number, number] {
	const position = target.apply_relative_transform_to_point(effect.actor, new Graphene.Point3D());
	const [width, height] = target.get_transformed_size();
	return [position.x - 1.5, position.y + 1, width + 2, height + 1];
}

// Based on https://gitlab.gnome.org/GNOME/mutter/-/blob/8b5c757bea75b7712bbe09c2018a8eb15b4d22cc/src/compositor/meta-background-content.c
function createGlslHoleEffect(): HoleEffectConstructor {
	class GlslHoleEffect extends Shell.GLSLEffect {
		private readonly _sizeLocation: number;
		private readonly _holeBoxLocation: number;

		constructor(private target: Clutter.Actor) {
			super();

			this._sizeLocation = this.get_uniform_location('size');
			this._holeBoxLocation = this.get_uniform_location('hole_box');

			target.connect('notify::allocation', () => this.queue_repaint());
		}

		override vfunc_paint_target(node: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
			this.set_uniform_float(this._sizeLocation, 2, this.actor.get_transformed_size());
			this.set_uniform_float(this._holeBoxLocation, 4, holeBox(this, this.target));

			super.vfunc_paint_target(node, paintContext);
		}

		override vfunc_build_pipeline(): void {
			this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, GLSL_HOLE_SHADER_DECLARATIONS, HOLE_SHADER_BODY, true);
		}
	}

	return GObject.registerClass(GlslHoleEffect) as unknown as HoleEffectConstructor;
}

// Shell.GLSLEffect was removed in GNOME 51, so the same shader is run through Clutter.ShaderEffect.
// https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests/4241
function createShaderHoleEffect(): HoleEffectConstructor {
	class ShaderHoleEffect extends Clutter.ShaderEffect {
		constructor(private target: Clutter.Actor) {
			super();

			target.connect('notify::allocation', () => this.queue_repaint());
		}

		private setFloat(name: string, value: number) {
			const gvalue = new GObject.Value();
			gvalue.init(GObject.TYPE_FLOAT);
			gvalue.set_float(value);
			this.set_uniform_value(name, gvalue);
		}

		override vfunc_paint_target(node: Clutter.PaintNode, paintContext: Clutter.PaintContext): void {
			const [width, height] = this.actor.get_transformed_size();
			this.setFloat('size_x', width);
			this.setFloat('size_y', height);

			const [x, y, holeWidth, holeHeight] = holeBox(this, this.target);
			this.setFloat('hole_x', x);
			this.setFloat('hole_y', y);
			this.setFloat('hole_width', holeWidth);
			this.setFloat('hole_height', holeHeight);

			super.vfunc_paint_target(node, paintContext);
		}

		// @ts-expect-error: vfunc_get_static_snippet was added in GNOME 51
		override vfunc_get_static_snippet(): Cogl.Snippet {
			const snippet = Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, SHADER_HOLE_SHADER_DECLARATIONS, null);
			snippet.set_replace(SHADER_HOLE_SHADER_BODY);
			return snippet;
		}
	}

	return GObject.registerClass(ShaderHoleEffect) as unknown as HoleEffectConstructor;
}

let holeEffectClass: HoleEffectConstructor | undefined;

function HoleEffect(target: Clutter.Actor): Clutter.Effect {
	holeEffectClass ??= VERSION >= 51 ? createShaderHoleEffect() : createGlslHoleEffect();
	return new holeEffectClass(target);
}
