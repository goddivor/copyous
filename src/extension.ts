import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import { ConsoleLike, Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import type { HLJSApi } from 'highlight.js';
import type { LanguageFn } from 'highlight.js';

import { getDataPath, getHljsPath, getInstalledHljsLanguages } from './lib/common/constants.js';
import { DbusService } from './lib/common/dbus.js';
import { ClipboardHistory, CopyousSettings, migrateSettings } from './lib/common/settings.js';
import { SoundManager, tryCreateSoundManager } from './lib/common/sound.js';
import { ClipboardEntry } from './lib/database/database.js';
import { ClipboardEntryTracker } from './lib/database/entryTracker.js';
import { ClipboardManager } from './lib/misc/clipboard.js';
import { NotificationManager } from './lib/misc/notifications.js';
import { ShortcutManager } from './lib/misc/shortcuts.js';
import { ThemeManager } from './lib/misc/theme.js';
import { ClipboardDialog } from './lib/ui/clipboardDialog.js';
import { ClipboardIndicator } from './lib/ui/indicator.js';

/** How long a history cycle stays open before the next press starts a fresh one. */
const CYCLE_TIMEOUT_SECONDS = 5;

export default class CopyousExtension extends Extension {
	public settings!: CopyousSettings;
	public logger!: ConsoleLike;

	public hljs: HLJSApi | null | undefined;
	// Two distinct monitors: one watches the highlight.js bundle so a late install is picked up, the
	// other watches the extra languages directory. Sharing a single field meant the bundle monitor
	// kept the languages monitor from ever being installed.
	private hljsFileMonitor: Gio.FileMonitor | undefined;
	private hljsLanguagesMonitor: Gio.FileMonitor | undefined;
	private hljsLanguages: Map<string, boolean> | undefined;
	private hljsCallbacks: (() => void)[] | undefined;

	public themeManager: ThemeManager | undefined;

	private clipboardDialog: ClipboardDialog | undefined;
	private indicator: ClipboardIndicator | undefined;

	private dbus: DbusService | undefined;

	public notificationManager: NotificationManager | undefined;
	private soundManager: SoundManager | undefined;

	public shortcutsManager: ShortcutManager | undefined;

	private entryTracker: ClipboardEntryTracker | undefined;
	private historyTimeoutId: number = -1;
	private updateHistory: boolean = false;
	private initEntryTrackerPromise: Promise<void> = Promise.resolve();
	private loadEntriesId: number = -1;
	private cycleEntries: ClipboardEntry[] | null = null;
	private cycleIndex: number = -1;
	private cycleTimeoutId: number = -1;

	public clipboardManager: ClipboardManager | undefined;

	/** Cancelled by `disable()`, so work started by `enable()` can bail out instead of resurrecting. */
	private cancellable: Gio.Cancellable | undefined;

	/**
	 * The token of the current `enable()`.
	 *
	 * Capture it before an `await` and hand it back to `isCancelled()` afterwards. Nothing started by
	 * `enable()` is cancellable on its own, so a lock/unlock cycle used to let a promise from the
	 * previous activation install its result into the new one - or into no one at all, leaking the
	 * database connection or the file monitor it had just created.
	 */
	public get token(): Gio.Cancellable | undefined {
		return this.cancellable;
	}

	/** Whether `disable()` has run since `token` was taken. A later `enable()` counts as cancelled. */
	public isCancelled(token: Gio.Cancellable | undefined): boolean {
		return token === undefined || token !== this.cancellable || token.is_cancelled();
	}

	override enable() {
		this.cancellable = new Gio.Cancellable();

		this.settings = this.getSettings();
		migrateSettings(this.settings);

		this.logger = this.getLogger();
		const error = this.logger.error.bind(this.logger);

		// Highlight.js
		this.initHljs().catch(error);

		// Theme
		this.themeManager = new ThemeManager(this);

		// UI
		this.clipboardDialog = new ClipboardDialog(this);
		this.clipboardDialog.connectObject(
			'notify::opened',
			async () => {
				// Update the history when the dialog is closed and an update was scheduled while the dialog was open
				if (!this.clipboardDialog?.opened && this.updateHistory) {
					await this.entryTracker?.deleteOldest();
				}
			},
			'copy',
			async (_: unknown, entry: ClipboardEntry) => {
				await this.clipboardManager?.copyEntry(entry);
				this.indicator?.showEntry(entry);
			},
			'paste',
			async (_: unknown, entry: ClipboardEntry) => {
				await this.clipboardManager?.pasteEntry(entry);
				this.indicator?.showEntry(entry);
			},
			'clear-history',
			(_: unknown, history: ClipboardHistory) => this.entryTracker?.clear(history),
			this,
		);

		this.indicator = new ClipboardIndicator(this);
		this.indicator.connectObject(
			'open-dialog',
			() => this.clipboardDialog?.toggle(),
			'clear-history',
			(_: unknown, history: ClipboardHistory) => this.entryTracker?.clear(history),
			this,
		);

		// DBus
		this.dbus = new DbusService();
		this.dbus.connectObject(
			'toggle',
			() => this.clipboardDialog?.toggle(),
			'show',
			() => this.clipboardDialog?.open(),
			'hide',
			() => this.clipboardDialog?.close(),
			'clear-history',
			(_: unknown, history: ClipboardHistory | -1) => this.entryTracker?.clear(history === -1 ? null : history),
			this,
		);

		// Feedback
		this.notificationManager = new NotificationManager(this);
		const soundToken = this.token;
		tryCreateSoundManager(this)
			.then((soundManager) => {
				if (!soundManager) return;

				// `disable()` may have run while GSound was loading; keeping the manager would leak a
				// GSound context that nothing destroys any more.
				if (this.isCancelled(soundToken)) soundManager.destroy();
				else this.soundManager = soundManager;
			})
			.catch(error);

		// Shortcuts
		this.shortcutsManager = new ShortcutManager(this, this.clipboardDialog);
		this.shortcutsManager.connectObject(
			'open-clipboard-dialog',
			() => this.clipboardDialog?.dialogShortcut(),
			'toggle-incognito-mode',
			() => this.indicator?.toggleIncognito(),
			'select-next-item',
			() => this.cycleItem(1),
			'select-previous-item',
			() => this.cycleItem(-1),
			this,
		);

		// Database
		this.entryTracker = new ClipboardEntryTracker(this);
		this.initEntryTracker().catch(error);
		this.initHistoryTimeout().catch(error);

		this.settings.connectObject(
			'changed::database-location',
			this.reinitEntryTracker.bind(this),
			'changed::database-backend',
			this.reinitEntryTracker.bind(this),
			'changed::history-time',
			this.initHistoryTimeout.bind(this),
			this,
		);

		// Clipboard Manager
		this.clipboardManager = new ClipboardManager(this, this.entryTracker);
		this.clipboardManager.connectObject(
			'clipboard',
			(_: unknown, entry: ClipboardEntry) => {
				// New content means the cycle's snapshot is stale.
				this.endCycle();

				this.clipboardDialog?.addEntry(entry);
				this.indicator?.showEntry(entry);
				this.indicator?.animate();
				this.notificationManager?.notification(entry);
				this.soundManager?.playSound();
			},
			'text',
			(_: unknown, text: string) => {
				this.indicator?.showText(text);
				this.indicator?.animate();
				this.notificationManager?.textNotification(text);
				this.soundManager?.playSound();
			},
			'image',
			(_: unknown, image: Uint8Array, width: number, height: number) => {
				this.indicator?.showImageBytes(image);
				this.indicator?.animate();
				this.notificationManager?.imageNotification(image, width, height);
				this.soundManager?.playSound();
			},
			this,
		);
	}

	private async initHljs() {
		if (this.hljs) return;

		const token = this.token;
		const hljsPath = getHljsPath(this);
		try {
			const hljs = (await import(hljsPath.get_uri())) as { default: HLJSApi };
			if (this.isCancelled(token)) return;

			this.hljs = hljs.default;

			// Disable file monitor
			this.hljsFileMonitor?.cancel();
			this.hljsFileMonitor = undefined;

			// Initialize extra languages
			await this.loadHljsLanguages();
			if (this.isCancelled(token)) return;

			// Notify dependents
			this.hljsCallbacks?.forEach((fn) => fn());
			this.hljsCallbacks = undefined;
		} catch {
			if (this.isCancelled(token)) return;

			this.hljs = null;

			// Automatically load highlight.js
			if (!this.hljsFileMonitor) {
				this.hljsFileMonitor = hljsPath.monitor(Gio.FileMonitorFlags.NONE, null);
				this.hljsFileMonitor.connectObject(
					'changed',
					async (_monitor: unknown, _file: unknown, _otherFile: unknown, eventType: Gio.FileMonitorEvent) => {
						if (eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
							await this.initHljs();
						}
					},
					this,
				);
			}
		}
	}

	private async loadHljsLanguages() {
		const token = this.token;
		this.hljsLanguages ??= new Map<string, boolean>();

		if (!this.hljsLanguagesMonitor) {
			const path = getDataPath(this).get_child('languages');
			this.hljsLanguagesMonitor = path.monitor_directory(Gio.FileMonitorFlags.NONE, null);
			this.hljsLanguagesMonitor.connectObject(
				'changed',
				async (_monitor: unknown, _file: unknown, _otherFile: unknown, eventType: Gio.FileMonitorEvent) => {
					if (
						eventType === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
						eventType === Gio.FileMonitorEvent.DELETED
					) {
						await this.loadHljsLanguages();
					}
				},
				this,
			);
		}

		const installed = await getInstalledHljsLanguages(this);
		if (this.isCancelled(token)) return;

		const files = new Map(installed);

		// Drop the languages whose file disappeared since the last pass
		for (const [name, enabled] of this.hljsLanguages) {
			if (enabled && !files.has(name)) {
				this.hljs?.unregisterLanguage(name);
				this.hljsLanguages.set(name, false);
			}
		}

		await Promise.all(
			installed.map(async ([name, path]) => {
				if (this.hljsLanguages?.get(name)) return;

				try {
					const language = (await import(path.get_uri())) as { default: LanguageFn };
					if (this.isCancelled(token)) return;

					this.hljs?.registerLanguage(name, language.default);
					this.hljsLanguages?.set(name, true);
				} catch {
					this.logger.error(`Failed to register language "${name}"`);
				}
			}),
		);
	}

	public connectHljsInit(fn: () => void) {
		if (this.hljs != null) return;

		this.hljsCallbacks ??= [];
		this.hljsCallbacks.push(fn);
	}

	private reinitEntryTracker() {
		// `init()` writes `database-backend` when it resolves the default backend, which fires this
		// handler right back. Reloading then would read the whole history a second time.
		if (this.entryTracker?.matchesSettings()) return;

		this.initEntryTracker().catch(this.logger.error.bind(this.logger));
	}

	private initEntryTracker(): Promise<void> {
		// Chain onto the pending initialization instead of racing it. Two concurrent runs would each
		// clear the dialog and then append the full history, which is what multiplied the entries.
		this.initEntryTrackerPromise = this.initEntryTrackerPromise
			.catch(() => undefined)
			.then(() => this.doInitEntryTracker());

		return this.initEntryTrackerPromise;
	}

	private async doInitEntryTracker() {
		const token = this.token;
		const entryTracker = this.entryTracker;
		if (!entryTracker) return;

		this.clipboardDialog?.clearEntries();
		const entries = await entryTracker.init();

		// `disable()` runs while the database is still opening on a fast lock/unlock cycle. It has
		// already destroyed a tracker that had no connection yet, so close the one that just opened
		// here instead of leaving it - and its Gda connection - behind.
		if (this.isCancelled(token)) {
			await entryTracker.destroy();
			return;
		}

		// Building one St actor per entry is what froze the session on login with a large history.
		// Spread it over idle callbacks at low priority so the shell keeps drawing frames, and stop
		// the previous run first: a re-init (or a lock/unlock cycle) would otherwise leave a second
		// loop appending into the dialog.
		this.stopLoadingEntries();

		if (entries.length === 0) return;

		const batchSize = 10;
		let index = 0;

		this.loadEntriesId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
			const end = Math.min(index + batchSize, entries.length);
			for (; index < end; index++) {
				this.clipboardDialog?.addEntryBatch(entries[index]!);
			}

			if (index < entries.length) return GLib.SOURCE_CONTINUE;

			this.clipboardDialog?.finishBatchLoadEntries();
			this.loadEntriesId = -1;
			return GLib.SOURCE_REMOVE;
		});
	}

	private stopLoadingEntries() {
		if (this.loadEntriesId >= 0) GLib.source_remove(this.loadEntriesId);
		this.loadEntriesId = -1;
	}

	private async initHistoryTimeout() {
		if (this.historyTimeoutId >= 0) GLib.source_remove(this.historyTimeoutId);

		const historyTime = this.settings?.get_int('history-time');
		if (historyTime === undefined || historyTime === 0) return;

		await this.entryTracker?.deleteOldest();
		this.historyTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
			// Do not update the history if the dialog is open
			this.updateHistory = this.clipboardDialog?.opened ?? false;
			if (this.updateHistory) return GLib.SOURCE_CONTINUE;

			if (this.entryTracker?.checkOldest()) {
				this.entryTracker?.deleteOldest().catch(this.logger.error.bind(this.logger));
			}

			return GLib.SOURCE_CONTINUE;
		});
	}

	/**
	 * Moves through the history in place, without opening the dialog.
	 *
	 * The list is snapshotted when a cycle starts and reused until the cycle ends, because copying
	 * an entry can refresh its datetime (update-date-on-copy) and would otherwise reorder the list
	 * under the user between two presses. The cycle ends when something new is copied, or after a
	 * few seconds of inactivity.
	 */
	private cycleItem(offset: number) {
		if (!this.clipboardManager) return;

		if (!this.cycleEntries) {
			// Index 0 is the entry already on the clipboard, so a cycle starts there and the first
			// press moves off it. Starting at -1 would have spent a press re-copying what is current.
			this.cycleEntries = this.entryTracker?.entries ?? [];
			this.cycleIndex = 0;
		}

		const entries = this.cycleEntries;
		if (entries.length === 0) return this.endCycle();

		// Wrap around at both ends, as the issue asks for.
		this.cycleIndex = (this.cycleIndex + offset + entries.length) % entries.length;

		const entry = entries[this.cycleIndex];
		if (!entry) return this.endCycle();

		this.clipboardManager.copyEntry(entry).catch(this.logger.error.bind(this.logger));
		this.indicator?.showEntry(entry);

		if (this.settings.get_boolean('show-selected-item-notification')) {
			this.notificationManager?.selectionNotification(entry);
		}

		if (this.cycleTimeoutId >= 0) GLib.source_remove(this.cycleTimeoutId);
		this.cycleTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CYCLE_TIMEOUT_SECONDS, () => {
			this.cycleTimeoutId = -1;
			this.endCycle();
			return GLib.SOURCE_REMOVE;
		});
	}

	private endCycle() {
		if (this.cycleTimeoutId >= 0) GLib.source_remove(this.cycleTimeoutId);
		this.cycleTimeoutId = -1;
		this.cycleEntries = null;
		this.cycleIndex = -1;
	}

	override disable() {
		// Stop the work `enable()` started: anything still awaiting bails out instead of installing
		// itself into an extension that no longer exists.
		this.cancellable?.cancel();
		this.cancellable = undefined;

		// UI
		this.clipboardDialog?.disconnectObject(this);
		this.clipboardDialog?.destroy();
		this.indicator?.disconnectObject(this);
		this.indicator?.destroy();
		this.clipboardDialog = undefined;
		this.indicator = undefined;

		// Highlight.js
		this.hljs = undefined;
		this.hljsFileMonitor?.disconnectObject(this);
		this.hljsFileMonitor?.cancel();
		this.hljsFileMonitor = undefined;
		this.hljsLanguagesMonitor?.disconnectObject(this);
		this.hljsLanguagesMonitor?.cancel();
		this.hljsLanguagesMonitor = undefined;
		this.hljsLanguages = undefined;
		this.hljsCallbacks = undefined;

		// Theme
		this.themeManager?.destroy();
		this.themeManager = undefined;

		// DBus
		this.dbus?.disconnectObject(this);
		this.dbus?.destroy();
		this.dbus = undefined;

		// Feedback
		this.notificationManager = undefined;
		this.soundManager?.destroy();
		this.soundManager = undefined;

		// Shortcuts
		this.shortcutsManager?.disconnectObject(this);
		this.shortcutsManager?.destroy();
		this.shortcutsManager = undefined;

		// Database
		const error = this.logger.error.bind(this.logger);
		this.stopLoadingEntries();
		this.endCycle();
		this.entryTracker?.destroy().catch(error);
		this.entryTracker = undefined;
		this.initEntryTrackerPromise = Promise.resolve();

		if (this.historyTimeoutId >= 0) GLib.source_remove(this.historyTimeoutId);
		this.historyTimeoutId = -1;

		// Clipboard Manager
		this.clipboardManager?.disconnectObject(this);
		this.clipboardManager?.destroy();
		this.clipboardManager = undefined;

		// Globals
		this.settings?.disconnectObject(this);
		this.settings = undefined!;
		this.logger = undefined!;
	}

	/* DEBUG-ONLY */
	override getSettings(schema?: string): Gio.Settings & CopyousSettings {
		try {
			const environment = GLib.get_environ();
			const settings = GLib.environ_getenv(environment, 'DEBUG_COPYOUS_SCHEMA');
			if (settings) {
				this.getLogger().log('Using debug schema');
				schema ??= this.metadata['settings-schema'] + '.debug';
			}

			return super.getSettings(schema) as Gio.Settings & CopyousSettings;
		} catch {
			// Fallback for when debug schema does not exist
			return super.getSettings() as Gio.Settings & CopyousSettings;
		}
	}
}
