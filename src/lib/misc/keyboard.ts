import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator/blob/89c57703641a9d5d15f899f6e780174641911d95/keyboard.js
export class Keyboard {
	private _device: Clutter.VirtualInputDevice | null = null;
	private _purpose: Clutter.InputContentPurpose = Clutter.InputContentPurpose.NORMAL;
	private _savedPurpose: Clutter.InputContentPurpose | null = null;
	private _inputMethod: Clutter.InputMethod | null = null;
	private _baseTime: number = 0;

	constructor() {
		const seat = global.stage.context.get_backend().get_default_seat();
		this._device = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

		// `Main.inputMethod` is only set up once the shell has finished starting, so it may still be
		// unset when the extension is enabled during login.
		const inputMethod = (Main.inputMethod ?? null) as Clutter.InputMethod | null;
		if (!inputMethod) return;

		this._inputMethod = inputMethod;
		this._purpose = inputMethod.content_purpose;

		inputMethod.connectObject(
			'notify::content-purpose',
			(method: { content_purpose: Clutter.InputContentPurpose }) => {
				this._purpose = method.content_purpose;
			},
			this,
		);
	}

	destroy() {
		this._inputMethod?.disconnectObject(this);
		this._inputMethod = null;
		this._device = null;
	}

	get purpose() {
		// Use saved purpose if available (set before dialog took focus)
		return this._savedPurpose !== null ? this._savedPurpose : this._purpose;
	}

	savePurpose() {
		// Save current purpose before dialog/modal takes focus and changes it
		this._savedPurpose = this._purpose;
	}

	resetPurpose() {
		// Restore to live purpose tracking
		this._savedPurpose = null;
	}

	private getTimestamp(): number {
		// Use monotonic time for accurate keyboard event timing
		if (this._baseTime === 0) {
			this._baseTime = GLib.get_monotonic_time() / 1000;
		}
		return Math.max(this._baseTime, Math.floor(GLib.get_monotonic_time() / 1000));
	}

	private notify(keyval: number, state: Clutter.KeyState) {
		this._device?.notify_keyval(this.getTimestamp(), keyval, state);
	}

	// Emit modifier state explicitly if available (GNOME 48+)
	private notifyModifiers(mods: Clutter.ModifierType) {
		// Check if notify_modifiers is available on the device
		if (!this._device) return;
		const device = this._device as unknown as Record<string, unknown>;
		const notifyModifiersFunc = device['notify_modifiers'];
		if (typeof notifyModifiersFunc === 'function') {
			try {
				(notifyModifiersFunc as (timestamp: number, mods: Clutter.ModifierType) => void)(
					this.getTimestamp(),
					mods,
				);
			} catch {
				// Silently ignore if not available
			}
		}
	}

	press(keyval: number) {
		this.notify(keyval, Clutter.KeyState.PRESSED);
	}

	release(keyval: number) {
		this.notify(keyval, Clutter.KeyState.RELEASED);
	}

	// Press multiple keys with proper modifier tracking
	pressWithModifiers(keyval: number, modifiers: Clutter.ModifierType[]) {
		let currentMods = 0;

		// Press all modifiers first
		for (const mod of modifiers) {
			currentMods |= mod;
			this.notifyModifiers(currentMods);
		}

		// Then press the main key
		this.notify(keyval, Clutter.KeyState.PRESSED);

		// Release the main key
		this.notify(keyval, Clutter.KeyState.RELEASED);

		// Release modifiers in reverse order
		for (let i = modifiers.length - 1; i >= 0; i--) {
			const mod = modifiers[i];
			if (mod !== undefined) {
				currentMods ^= mod;
				this.notifyModifiers(currentMods);
			}
		}
	}
}
