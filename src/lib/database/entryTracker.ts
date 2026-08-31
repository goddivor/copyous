import GLib from 'gi://GLib';
import type Gda from 'gi://Gda';
import Gio from 'gi://Gio';

import type CopyousExtension from '../../extension.js';
import { ItemType, getDefaultDatabaseFile } from '../common/constants.js';
import { ClipboardHistory, DatabaseBackend } from '../common/settings.js';
import { getLinkImagePath } from '../misc/link.js';
import { ClipboardEntry, Database, Metadata } from './database.js';
import { GdaDatabase } from './gda.js';
import { JsonDatabase } from './json.js';
import { MemoryDatabase } from './memory.js';

export class ClipboardEntryTracker {
	private _database: Database | undefined;
	private _entries: Map<number, ClipboardEntry> = new Map();
	private _activeConfig: string | undefined;

	constructor(private ext: CopyousExtension) {}

	async init(): Promise<ClipboardEntry[]> {
		const token = this.ext.token;

		if (this._database) {
			// Close without clearing on re-initialization
			await this.destroy();
		}

		// The tracked set is rebuilt from the database below, so nothing from the previous backend
		// should survive: the ids of another database mean nothing here.
		this._entries.clear();

		const backend: DatabaseBackend = this.ext.settings.get_enum('database-backend');
		const file = this.getFile();
		const dir = file.get_parent()!;
		const fileName = file.get_basename()!.replace(/(\.db|\.json)$/, '');
		const dbFile = dir.get_child(`${fileName}.db`);
		const jsonFile = dir.get_child(`${fileName}.json`);

		// Default database strategy is as followed:
		// 1. (memory)  in-memory-database (deprecated) set to true
		// 2. (sqlite)  .db file exists
		// 3. (json)    .json file exists
		// 4. (sqlite)  sqlite backend can be loaded
		// 5. (json)    json backend can be loaded
		// 6. fallback to in-memory
		let opened = false;
		if (backend === DatabaseBackend.Default) {
			if (this.ext.settings.get_boolean('in-memory-database')) {
				this.ext.logger.log('Set default database backend to in-memory');
				opened = await this.initMemory();
			} else if (dbFile.query_exists(null)) {
				opened = await this.initSqlite(dbFile, true);
				if (opened) {
					this.ext.settings.set_enum('database-backend', DatabaseBackend.Sqlite);
					this.ext.logger.log('Set default database backend to SQLite');
				}
			} else if (jsonFile.query_exists(null)) {
				opened = await this.initJson(jsonFile);
				if (opened) {
					this.ext.settings.set_enum('database-backend', DatabaseBackend.Json);
					this.ext.logger.log('Set default database backend to JSON');
				}
			} else {
				opened = await this.initSqlite(dbFile, false);
				if (opened) {
					this.ext.settings.set_enum('database-backend', DatabaseBackend.Sqlite);
					this.ext.logger.log('Set default database backend to SQLite');
				} else {
					opened = await this.initJson(jsonFile);
					if (opened) {
						this.ext.settings.set_enum('database-backend', DatabaseBackend.Json);
						this.ext.logger.log('Set default database backend to JSON');
					} else {
						opened = await this.initMemory();
						this.ext.settings.set_enum('database-backend', DatabaseBackend.Memory);
						this.ext.logger.log('Set default database backend to in-memory');
					}
				}
			}
		} else if (backend === DatabaseBackend.Sqlite) {
			opened = await this.initSqlite(dbFile, true);
		} else if (backend === DatabaseBackend.Json) {
			opened = await this.initJson(jsonFile);
		}

		// Fallback to in-memory
		if (!opened) await this.initMemory();

		// `disable()` can land while the backend was still opening. Everything below reads settings,
		// which are already gone at that point, so close what was just opened and report nothing.
		if (this.ext.isCancelled(token)) {
			await this.destroy();
			return [];
		}

		this._activeConfig = this.currentConfig();

		// Prune before reading, not after.
		//
		// `history-length` and `history-time` decide what the history is allowed to hold, and the
		// pruning honours pinned and tagged entries, so it is the only correct way to bound the
		// initial read: a plain `LIMIT` would hide pinned entries. Reading first meant every row that
		// was about to be deleted still became a `ClipboardEntry`, and was still handed to the dialog
		// to be turned into an actor - for rows that no longer existed by then.
		await this.deleteOldest();

		const entries = (await this._database?.entries()) ?? [];

		// Track all entries
		this.track(...entries);

		return entries;
	}

	/**
	 * Whether the loaded database already matches the current settings.
	 *
	 * `init()` writes `database-backend` itself when it resolves the default backend, which fires
	 * `changed::database-backend` right back at the extension. Reloading there would read the whole
	 * history a second time, so the settings handler uses this to skip the redundant work.
	 */
	/**
	 * The tracked entries, newest first.
	 *
	 * Insertion order follows the database, which returns rows ordered by descending datetime, so
	 * the map preserves that order; sorting explicitly keeps it correct after later date updates.
	 */
	public get entries(): ClipboardEntry[] {
		return Array.from(this._entries.values()).sort((a, b) => b.datetime.compare(a.datetime));
	}

	public matchesSettings(): boolean {
		return this._database !== undefined && this._activeConfig === this.currentConfig();
	}

	private currentConfig(): string {
		return `${this.ext.settings.get_enum('database-backend')}:${this.getFile().get_path() ?? ''}`;
	}

	private getFile(): Gio.File {
		// Check if DEBUG_COPYOUS_DBPATH is set
		const environment = GLib.get_environ();
		const debugPath = GLib.environ_getenv(environment, 'DEBUG_COPYOUS_DBPATH');
		if (debugPath) {
			this.ext.logger.log('Using debug database');
			return Gio.File.new_for_path(debugPath);
		}

		// Get database location or use default ${XDG_DATA_HOME}/${EXTENSION UUID}
		const location = this.ext.settings.get_string('database-location');
		return location ? Gio.File.new_for_path(location) : getDefaultDatabaseFile(this.ext, DatabaseBackend.Default);
	}

	/** Opens the SQLite backend. Returns whether it is usable; the entries are read by `init()`. */
	private async initSqlite(file: Gio.File | null, showError: boolean): Promise<boolean> {
		// Check if DEBUG_COPYOUS_GDA_VERSION is set. The version has to be pinned on the import
		// itself: `imports.package.require()` is the legacy import system, which does not exist in an
		// ESM extension, so the call only ever threw and the variable did nothing.
		const gdaVersion = GLib.getenv('DEBUG_COPYOUS_GDA_VERSION');
		const gdaImport = gdaVersion ? `gi://Gda?version=${gdaVersion}` : 'gi://Gda';

		let gda: typeof Gda;
		try {
			gda = ((await import(gdaImport)) as { default: typeof Gda }).default;
		} catch {
			this.ext.logger.error(`Failed to load Gda`);

			if (showError && !this.ext.settings.get_boolean('disable-gda-warning')) {
				this.ext.notificationManager?.warning(
					_('Failed to load Gda'),
					_('Clipboard history will be disabled'),
					[_('Disable Warning'), () => this.ext.settings.set_boolean('disable-gda-warning', true)],
				);
			}
			return false;
		}

		try {
			this.ext.logger.log(`Using ${file === null ? 'in-memory ' : ''}Gda ${gda.__version__} database`);
			this._database = new GdaDatabase(this.ext, gda, file);
			await this._database.init();
			return true;
		} catch (e) {
			this.ext.logger.error('Failed to load Gda', e);
			// Close database connection before fallback
			if (this._database) {
				await this._database.close();
				this._database = undefined;
			}
			this.ext.notificationManager?.warning(_('Failed to load Gda'), _('Clipboard history will be disabled'));

			return false;
		}
	}

	/** Opens the JSON backend. Returns whether it is usable; the entries are read by `init()`. */
	private async initJson(file: Gio.File | null): Promise<boolean> {
		if (file === null) return await this.initMemory();

		try {
			this.ext.logger.log('Using JSON database');
			this._database = new JsonDatabase(this.ext, file);
			await this._database.init();
			return true;
		} catch (e) {
			this.ext.logger.error('Failed to initialize JSON database', e);
			this.ext.notificationManager?.warning(_('Failed to load JSON'), _('Clipboard history will be disabled'));

			return false;
		}
	}

	private async initMemory(): Promise<boolean> {
		this.ext.logger.log('Using in-memory database');

		this._database = new MemoryDatabase();
		await this._database.init();
		return true;
	}

	public async clear(history: ClipboardHistory | null = null) {
		if (!this._database) return;

		history ??= this.ext.settings.get_enum('clipboard-history');
		const deleted = await this._database.clear(history);
		deleted.forEach((id) => this.deleteFromDatabase(id));
	}

	public async destroy() {
		this._activeConfig = undefined;

		await this._database?.close();
		this._database = undefined;
	}

	/**
	 * Inserts an entry into the database
	 * @param type The type of the entry
	 * @param content The content of the entry
	 * @param metadata The metadata of the entry
	 * @returns The inserted entry or null if the entry could not be inserted or is already tracked
	 */
	public async insert(
		type: ItemType,
		content: string,
		metadata: Metadata | null = null,
	): Promise<ClipboardEntry | null> {
		const id = await this._database?.selectConflict({ type, content });
		if (id != null) {
			// Check if the entry is already tracked
			const trackedEntry = this._entries.get(id);
			if (trackedEntry) {
				trackedEntry.datetime = GLib.DateTime.new_now_utc();
				return null;
			}
		}

		const entry = await this._database?.insert(type, content, metadata);
		if (!entry) return null;

		// Start tracking it
		this.track(entry);

		// Also delete oldest entries
		await this.deleteOldest();

		return entry;
	}

	public checkOldest(): boolean {
		const M = this.ext.settings.get_int('history-time');
		if (M === 0) return false;

		const now = GLib.DateTime.new_now_utc();
		const olderThan = now.add_minutes(-M)!;

		for (const entry of this._entries.values()) {
			if (entry.pinned || entry.tag) continue;
			if (entry.datetime.compare(olderThan) < 0) return true;
		}

		return false;
	}

	public async deleteOldest() {
		const N = this.ext.settings.get_int('history-length');
		const M = this.ext.settings.get_int('history-time');
		const deleted = await this._database?.deleteOldest(N, M);
		if (deleted) deleted.forEach((id) => this.deleteFromDatabase(id));
	}

	private track(...entries: ClipboardEntry[]) {
		for (const entry of entries) {
			entry.connect('notify::content', async () => {
				const id = await this._database?.updateProperty(entry, 'content');
				// If entry conflicts with another entry, delete it
				if (id !== undefined && id >= 0) {
					entry.emit('delete');

					// Update the date of the other entry
					const conflicted = this._entries.get(id);
					if (conflicted) {
						conflicted.datetime = entry.datetime;
					}
				}
			});
			entry.connect('notify::pinned', () => this._database?.updateProperty(entry, 'pinned'));
			entry.connect('notify::tag', () => this._database?.updateProperty(entry, 'tag'));
			entry.connect('notify::datetime', () => this._database?.updateProperty(entry, 'datetime'));
			entry.connect('notify::metadata', () => this._database?.updateProperty(entry, 'metadata'));
			entry.connect('notify::title', () => this._database?.updateProperty(entry, 'title'));
			entry.connect('delete', () => this.delete(entry));
			this._entries?.set(entry.id, entry);
		}
	}

	private async delete(entry: ClipboardEntry) {
		if (entry.type === ItemType.Image) {
			// Delete image
			try {
				const file = Gio.File.new_for_uri(entry.content);
				if (file.query_exists(null)) {
					file.delete(null);
				}
			} catch {
				this.ext.logger.error('Failed to delete image', entry.content);
			}
		} else if (entry.type === ItemType.Link && entry.metadata) {
			// Delete thumbnail image
			const metadata: { image: string | null } = { image: null, ...entry.metadata };
			if (metadata.image) {
				try {
					const file = getLinkImagePath(this.ext, metadata.image);
					if (file?.query_exists(null)) {
						file.delete(null);
					}
				} catch {
					this.ext.logger.error('Failed to delete thumbnail image', metadata.image);
				}
			}
		}

		// Delete from database if not deleted already
		if (this._entries.has(entry.id)) {
			await this._database?.delete(entry);
			this._entries.delete(entry.id);
		}
	}

	private deleteFromDatabase(id: number) {
		const entry = this._entries.get(id);
		if (entry) {
			this._entries.delete(id);
			entry.emit('delete');
		}
	}
}
