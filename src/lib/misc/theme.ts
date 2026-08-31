import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import CopyousExtension from '../../extension.js';
import { DefaultColors, getDataPath } from '../common/constants.js';
import { enumParamSpec, registerClass } from '../common/gjs.js';
import { ColorScheme, CustomColorScheme, Theme, ThemeSettings } from '../common/settings.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');

@registerClass({
	Properties: {
		'color-scheme': enumParamSpec(
			'color-scheme',
			GObject.ParamFlags.READABLE,
			CustomColorScheme,
			CustomColorScheme.Dark,
		),
	},
})
export class ThemeManager extends GObject.Object {
	private readonly _resource: Gio.Resource;
	private readonly _themeSettings: ThemeSettings;
	private readonly _settings: St.Settings;
	private readonly _contrastChangedId: number;
	private readonly _colorSchemeChangedId: number;
	private readonly _themeContextChangedId: number | null;

	private _stylesheet: Gio.File | null = null;
	private _updatingTheme: boolean = false;
	private _lastCustomCss: string | null = null;
	private _colorScheme: CustomColorScheme = CustomColorScheme.Dark;

	constructor(private ext: CopyousExtension) {
		super();

		this._resource = Gio.resource_load(`${this.ext.path}/theme.gresource`);
		Gio.resources_register(this._resource);

		this._themeSettings = this.ext.settings.get_child('theme');
		this._themeSettings.connectObject('changed', this.updateTheme.bind(this), this);

		this._settings = St.Settings.get();

		this._contrastChangedId = this._settings.connect('notify::high-contrast', this.updateTheme.bind(this));
		this._colorSchemeChangedId = this._settings.connect('notify::color-scheme', this.updateTheme.bind(this));

		// Listen for theme changes in St.ThemeContext
		const themeContext = St.ThemeContext.get_for_stage(global.stage);
		this._themeContextChangedId = themeContext.connect('changed', this.updateTheme.bind(this));

		this.updateTheme().catch(() => {});
	}

	private get theme(): St.Theme {
		return St.ThemeContext.get_for_stage(global.stage).get_theme();
	}

	get colorScheme(): CustomColorScheme {
		return this._colorScheme;
	}

	private set colorScheme(scheme: CustomColorScheme) {
		if (scheme === this._colorScheme) return;

		this._colorScheme = scheme;
		this.notify('color-scheme');
	}

	destroy() {
		if (this._stylesheet) this.theme.unload_stylesheet(this._stylesheet);
		this._stylesheet = null;
		Gio.resources_unregister(this._resource);
		this._themeSettings.disconnectObject(this);
		this._settings.disconnect(this._contrastChangedId);
		this._settings.disconnect(this._colorSchemeChangedId);
		if (this._themeContextChangedId !== null) {
			const themeContext = St.ThemeContext.get_for_stage(global.stage);
			themeContext.disconnect(this._themeContextChangedId);
		}
	}

	/**
	 * Reads a colour out of the live shell theme.
	 *
	 * The ancestors are built as real actors because the shell theme states most of its colours
	 * through descendant selectors: a bare `popup-menu-item` on the stage matches none of them.
	 */
	private sampleColor(classPath: string[], getter: (node: St.ThemeNode) => Cogl.Color): string | null {
		let root: St.Widget | null = null;
		let leaf: St.Widget | null = null;

		for (const styleClass of classPath) {
			const widget = new St.Widget({ style_class: styleClass });
			if (leaf) leaf.add_child(widget);
			else root = widget;
			leaf = widget;
		}

		if (!root || !leaf) return null;

		// The actor has to be in the scene graph for the theme to resolve, but it must not be drawn.
		root.visible = false;
		global.stage.add_child(root);

		try {
			const color = getter(leaf.get_theme_node());

			// A fully transparent result means the selector matched nothing worth copying.
			if (color.alpha === 0) return null;

			return `rgb(${color.red},${color.green},${color.blue})`;
		} catch (e) {
			this.ext.logger.debug(`Failed to sample color from ${classPath.join(' ')}: ${String(e)}`);
			return null;
		} finally {
			global.stage.remove_child(root);
			root.destroy();
		}
	}

	private firstColor(candidates: [string[], (node: St.ThemeNode) => Cogl.Color][], fallback: string): string {
		for (const [classPath, getter] of candidates) {
			const color = this.sampleColor(classPath, getter);
			if (color) return color;
		}

		return fallback;
	}

	private sampleShellThemeColors(): Record<string, string> {
		const background = (node: St.ThemeNode) => node.get_background_color();
		const foreground = (node: St.ThemeNode) => node.get_foreground_color();
		const i = Math.min(this.colorScheme, 1);

		return {
			bg_color: this.firstColor(
				[
					[['popup-menu', 'popup-menu-content'], background],
					[['panel'], background],
				],
				DefaultColors['custom-bg-color'][i] ?? DefaultColors['custom-bg-color'][0],
			),
			fg_color: this.firstColor(
				[
					[['popup-menu', 'popup-menu-content', 'popup-menu-item'], foreground],
					[['popup-menu', 'popup-menu-content'], foreground],
					[['panel'], foreground],
				],
				DefaultColors['custom-fg-color'][i] ?? DefaultColors['custom-fg-color'][0],
			),
			card_bg_color: this.firstColor(
				[
					[['message-list', 'message'], background],
					[['popup-menu', 'popup-menu-content', 'popup-menu-item'], background],
				],
				DefaultColors['custom-card-bg-color'][i] ?? DefaultColors['custom-card-bg-color'][0],
			),
			search_bg_color: this.firstColor(
				[
					[['search-entry'], background],
					[['message-list', 'message'], background],
				],
				DefaultColors['custom-search-bg-color'][i] ?? DefaultColors['custom-search-bg-color'][0],
			),
		};
	}

	private async updateTheme() {
		// St.Theme.load_stylesheet emits custom-stylesheets-changed, which St.ThemeContext relays as
		// its own changed signal - the one this class listens to. Without this guard the listener
		// would call straight back into here and spin forever.
		if (this._updatingTheme) return;

		this._updatingTheme = true;
		try {
			await this.doUpdateTheme();
		} finally {
			this._updatingTheme = false;
		}
	}

	private async doUpdateTheme() {
		let theme = this._themeSettings.get_enum('theme');

		this.colorScheme = (() => {
			if (theme === Theme.Custom || theme === Theme.System) {
				return this._themeSettings.get_enum('custom-color-scheme');
			}

			const colorScheme = this._themeSettings.get_enum('color-scheme');
			if (colorScheme === ColorScheme.System) {
				return this._settings.high_contrast
					? CustomColorScheme.HighContrast
					: Main.getStyleVariant() === 'light'
						? CustomColorScheme.Light
						: CustomColorScheme.Dark;
			} else {
				return (colorScheme - 1) as CustomColorScheme;
			}
		})();

		const colorScheme = (['dark', 'light', 'high-contrast'] as const)[this.colorScheme];

		// Custom Theme or System Theme
		if (theme === Theme.Custom || theme === Theme.System) {
			try {
				// Load template
				const uri = `resource:///org/gnome/shell/extensions/copyous/css/template-${colorScheme}.css`;
				const template = Gio.File.new_for_uri(uri);
				const [contents] = await template.load_contents_async(null);
				const text = new TextDecoder().decode(contents);

				// Determine colors to use
				let themeColors: Record<string, string>;
				if (theme === Theme.System) {
					// Sample colors from the shell theme
					themeColors = this.sampleShellThemeColors();
				} else {
					// Use custom colors from settings
					themeColors = Object.fromEntries(
						Object.entries(DefaultColors).map(([key, colors]) => {
							const i = Math.min(this.colorScheme, colors.length - 1);
							let color = this._themeSettings.get_string(key as keyof typeof DefaultColors);
							color = color ? color : colors[i]!;
							return [key.substring('custom-'.length).replace(/-/g, '_'), color];
						}),
					);
				}

				// Fill template with colors
				const css = Object.entries(themeColors).reduce((s, [variable, color]) => {
					return s.replaceAll(`$${variable}`, color);
				}, text);

				// Nothing to do when the generated stylesheet is unchanged. This matters for the
				// system theme, whose colours are resampled on every shell theme change.
				if (css === this._lastCustomCss && this._stylesheet) return;

				// Save theme
				const path = getDataPath(this.ext);
				const stylesheet = path.get_child('custom-theme.css');

				const bytes = new TextEncoder().encode(css);
				await stylesheet.replace_contents_async(
					bytes,
					null,
					false,
					Gio.FileCreateFlags.REPLACE_DESTINATION,
					null,
				);

				// Load theme
				if (this._stylesheet) this.theme.unload_stylesheet(this._stylesheet);
				this.theme.load_stylesheet(stylesheet);
				this._stylesheet = stylesheet;
				this._lastCustomCss = css;
				return;
			} catch (err) {
				theme = Theme.Default;
				this.ext.logger.error(err);
			}
		}

		// GNOME Theme
		this._lastCustomCss = null;
		const themeName = (['default', 'yaru'] as const)[theme];
		const uri = `resource:///org/gnome/shell/extensions/copyous/css/stylesheet-${themeName}-${colorScheme}.css`;
		const stylesheet = Gio.File.new_for_uri(uri);

		if (this._stylesheet?.equal(stylesheet)) return;

		try {
			if (this._stylesheet) this.theme.unload_stylesheet(this._stylesheet);
			this.theme.load_stylesheet(stylesheet);
			this._stylesheet = stylesheet;
		} catch (err) {
			this.ext.logger.error(err);
		}
	}
}
