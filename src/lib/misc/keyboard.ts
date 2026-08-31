import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// https://github.com/Tudmotu/gnome-shell-extension-clipboard-indicator/blob/89c57703641a9d5d15f899f6e780174641911d95/keyboard.js
export class Keyboard {
	private _device: Clutter.VirtualInputDevice | null = null;
	private _purpose: Clutter.InputContentPurpose = Clutter.InputContentPurpose.NORMAL;
	private _inputMethod: Clutter.InputMethod | null = null;

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
		return this._purpose;
	}

	private notify(keyval: number, state: Clutter.KeyState) {
		this._device?.notify_keyval(Clutter.get_current_event_time() * 1000, keyval, state);
	}

	press(keyval: number) {
		this.notify(keyval, Clutter.KeyState.PRESSED);
	}

	release(keyval: number) {
		this.notify(keyval, Clutter.KeyState.RELEASED);
	}
}
