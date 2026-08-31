import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import type CopyousExtension from '../../extension.js';
import { enumParamSpec, registerClass } from '../common/gjs.js';
import {
	get_first_visible_child,
	get_last_visible_child,
	get_n_visible_children,
	get_next_visible_sibling,
	get_previous_visible_sibling,
	get_visible_sibling,
} from '../misc/actor.js';
import { ClipboardItem } from './items/clipboardItem.js';
import { State, StatusItem } from './items/statusItem.js';
import { SearchChange, SearchQuery } from './searchEntry.js';

/**
 * Lays the visible children of a container out in a grid.
 *
 * Cells are filled in child order, one line at a time along `orientation`, wrapping to the next
 * line after `itemsPerLine` items. Reading the grid left to right and then top to bottom (top to
 * bottom and then left to right when the orientation is vertical) therefore yields exactly the
 * order of the children, which is the order the container maintains on insertion. Hidden children
 * are skipped rather than given a cell, so a search that filters the list leaves no holes.
 *
 * `Clutter.GridLayout` was not used: it stores an explicit (column, row) per child, which would
 * have to be recomputed for every child on every insertion, re-sort and visibility change.
 * `Clutter.FlowLayout` was not used either: it derives the number of lines from the available size
 * and cannot honor a fixed line length.
 */
@registerClass()
class ClipboardGridLayout extends Clutter.LayoutManager {
	private _orientation: Clutter.Orientation = Clutter.Orientation.HORIZONTAL;
	private _spacing: number = 0;
	private _itemsPerLine: number = 1;

	// Last cell size measured while items were visible. The status item replaces the items when
	// nothing matches the search, and it is not item sized, so measuring it would resize the whole
	// dialog for as long as the search matches nothing.
	private _cellWidth: number = 0;
	private _cellHeight: number = 0;

	get orientation(): Clutter.Orientation {
		return this._orientation;
	}

	set orientation(value: Clutter.Orientation) {
		if (this._orientation === value) return;

		this._orientation = value;
		this.layout_changed();
	}

	get spacing(): number {
		return this._spacing;
	}

	set spacing(value: number) {
		if (this._spacing === value) return;

		this._spacing = value;
		this.layout_changed();
	}

	get itemsPerLine(): number {
		return this._itemsPerLine;
	}

	set itemsPerLine(value: number) {
		const items = Math.max(1, value);
		if (this._itemsPerLine === items) return;

		this._itemsPerLine = items;
		this.layout_changed();
	}

	private static visibleChildren(container: Clutter.Actor): Clutter.Actor[] {
		return container.get_children().filter((child) => child.visible);
	}

	/**
	 * Whether the container holds nothing but the status item, which is given the whole box instead
	 * of a single cell so that it stays centered like it is in a single line.
	 */
	private static isStatusOnly(children: Clutter.Actor[]): boolean {
		return children.length === 1 && !(children[0] instanceof ClipboardItem);
	}

	/**
	 * The size of a single cell. Every cell is as large as the largest visible item so that the
	 * columns and the rows line up.
	 */
	private cellSize(container: Clutter.Actor): [number, number] {
		let width = 0;
		let height = 0;
		for (const child of ClipboardGridLayout.visibleChildren(container)) {
			if (!(child instanceof ClipboardItem)) continue;

			const [, natWidth] = child.get_preferred_width(-1);
			const [, natHeight] = child.get_preferred_height(-1);
			width = Math.max(width, natWidth);
			height = Math.max(height, natHeight);
		}

		if (width > 0 && height > 0) {
			this._cellWidth = width;
			this._cellHeight = height;
		}

		return [this._cellWidth, this._cellHeight];
	}

	/**
	 * The number of lines the visible children are laid out on.
	 * @param container The container to lay out.
	 * @returns the number of lines, at least one.
	 */
	public lineCount(container: Clutter.Actor): number {
		return Math.max(1, Math.ceil(get_n_visible_children(container) / this._itemsPerLine));
	}

	/**
	 * The size of the grid along the scroll axis that does not fit in `maxLines` lines.
	 * @param container The container to lay out.
	 * @param maxLines The number of lines that should be shown at once.
	 * @returns the size that has to be trimmed from the preferred size of the container.
	 */
	public overflow(container: Clutter.Actor, maxLines: number): number {
		const [cellWidth, cellHeight] = this.cellSize(container);
		const cell = this._orientation === Clutter.Orientation.HORIZONTAL ? cellHeight : cellWidth;

		const lines = this.lineCount(container);
		const shown = Math.max(1, Math.min(maxLines, lines));
		return (lines - shown) * (cell + this._spacing);
	}

	/**
	 * The number of columns and rows of the grid.
	 */
	private gridSize(container: Clutter.Actor): [number, number] {
		const lines = this.lineCount(container);
		return this._orientation === Clutter.Orientation.HORIZONTAL
			? [this._itemsPerLine, lines]
			: [lines, this._itemsPerLine];
	}

	override vfunc_get_preferred_width(container: Clutter.Actor, _forHeight: number): [number, number] {
		const children = ClipboardGridLayout.visibleChildren(container);
		if (children.length === 0) return [0, 0];

		const [cellWidth] = this.cellSize(container);
		const [columns] = this.gridSize(container);

		// The status item is the only child while the history is empty or nothing matches the
		// search, but the grid keeps the width it has with items so the dialog does not resize.
		const width = Math.max(columns * cellWidth + (columns - 1) * this._spacing, 0);
		if (ClipboardGridLayout.isStatusOnly(children)) {
			const [minWidth, natWidth] = children[0]!.get_preferred_width(-1);
			const min = Math.max(width, minWidth);

			// Clutter aborts the shell when the natural size is below the minimum, so the natural
			// size is raised to the minimum rather than taken on its own.
			return [min, Math.max(min, natWidth)];
		}

		return [width, width];
	}

	override vfunc_get_preferred_height(container: Clutter.Actor, _forWidth: number): [number, number] {
		const children = ClipboardGridLayout.visibleChildren(container);
		if (children.length === 0) return [0, 0];

		const [, cellHeight] = this.cellSize(container);
		const [, rows] = this.gridSize(container);

		const height = Math.max(rows * cellHeight + (rows - 1) * this._spacing, 0);
		if (ClipboardGridLayout.isStatusOnly(children)) {
			const [minHeight, natHeight] = children[0]!.get_preferred_height(-1);
			const min = Math.max(height, minHeight);

			// Same invariant as above: the natural size can never sit below the minimum.
			return [min, Math.max(min, natHeight)];
		}

		return [height, height];
	}

	override vfunc_allocate(container: Clutter.Actor, allocation: Clutter.ActorBox): void {
		const children = ClipboardGridLayout.visibleChildren(container);
		if (children.length === 0) return;

		if (ClipboardGridLayout.isStatusOnly(children)) {
			children[0]!.allocate(allocation);
			return;
		}

		const [cellWidth, cellHeight] = this.cellSize(container);
		const horizontal = this._orientation === Clutter.Orientation.HORIZONTAL;
		const rtl = container.text_direction === Clutter.TextDirection.RTL;

		for (const [i, child] of children.entries()) {
			const line = Math.floor(i / this._itemsPerLine);
			const position = i % this._itemsPerLine;
			const column = horizontal ? position : line;
			const row = horizontal ? line : position;

			const x = rtl
				? allocation.x2 - (column + 1) * cellWidth - column * this._spacing
				: allocation.x1 + column * (cellWidth + this._spacing);
			const y = allocation.y1 + row * (cellHeight + this._spacing);

			child.allocate(new Clutter.ActorBox({ x1: x, y1: y, x2: x + cellWidth, y2: y + cellHeight }));
		}
	}
}

@registerClass({
	Properties: {
		orientation: enumParamSpec(
			'orientation',
			GObject.ParamFlags.READWRITE,
			Clutter.Orientation,
			Clutter.Orientation.HORIZONTAL,
		),
	},
})
export class ClipboardScrollContainer extends St.Viewport {
	private readonly _ext: CopyousExtension;
	private readonly _statusItem: StatusItem;

	// The container is a viewport rather than a St.BoxLayout so that the layout manager can be
	// swapped for the grid one. St.BoxLayout is a viewport that hard-casts its layout manager to a
	// Clutter.BoxLayout whenever its orientation is read or written, which any other layout manager
	// would turn into a stream of criticals.
	private readonly _boxLayout: Clutter.BoxLayout;
	private readonly _gridLayout: ClipboardGridLayout;

	private _orientation: Clutter.Orientation = Clutter.Orientation.HORIZONTAL;
	private _spacing: number = 0;
	private _gridMode: boolean = false;
	private _lastFocus: Clutter.Actor | null = null;
	private _lastQuery: SearchQuery | null = null;

	constructor(ext: CopyousExtension) {
		super({
			style_class: 'clipboard-item-list',
			x_align: Clutter.ActorAlign.START,
			x_expand: false,
		});

		this._ext = ext;

		this._boxLayout = new Clutter.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL });
		this._gridLayout = new ClipboardGridLayout();
		this.layout_manager = this._boxLayout;

		this._statusItem = new StatusItem(ext);

		// prettier-ignore
		this._ext.settings.connectObject(
			'changed::grid-mode', this.updateGrid.bind(this),
			'changed::grid-items-per-line', this.updateGrid.bind(this),
			this);

		this.updateGrid();
		this.updateVisible();
	}

	override destroy(): void {
		this._ext.settings.disconnectObject(this);

		super.destroy();
	}

	get orientation(): Clutter.Orientation {
		return this._orientation;
	}

	set orientation(value: Clutter.Orientation) {
		if (this._orientation === value) return;

		this._orientation = value;
		this._boxLayout.orientation = value;
		this._gridLayout.orientation = value;
		this.notify('orientation');
	}

	/** Whether the items are laid out in a grid instead of a single line. */
	get gridMode(): boolean {
		return this._gridMode;
	}

	/** The spacing between two items, taken from the `spacing` CSS property. */
	get spacing(): number {
		return this._spacing;
	}

	/**
	 * The axis the items scroll along. A grid is filled along its orientation and therefore scrolls
	 * perpendicular to it, a single line scrolls along its orientation.
	 */
	get scrollOrientation(): Clutter.Orientation {
		if (!this._gridMode) return this._orientation;

		return this._orientation === Clutter.Orientation.HORIZONTAL
			? Clutter.Orientation.VERTICAL
			: Clutter.Orientation.HORIZONTAL;
	}

	/**
	 * The size along the scroll axis that has to be trimmed from the preferred size of the
	 * container so that at most `maxLines` lines of the grid are shown at once.
	 * @param maxLines The number of lines that should be shown at once.
	 * @returns the size to trim, zero when the items are laid out in a single line.
	 */
	public gridOverflow(maxLines: number): number {
		if (!this._gridMode) return 0;

		return this._gridLayout.overflow(this, maxLines);
	}

	private updateGrid(): void {
		this._gridLayout.itemsPerLine = this._ext.settings.get_int('grid-items-per-line');

		const gridMode = this._ext.settings.get_boolean('grid-mode');
		if (gridMode === this._gridMode) return;

		this._gridMode = gridMode;

		// The first-child and last-child margins pad the two ends of a single line. In a grid they
		// would offset the first and the last cell only, which breaks the alignment of the columns.
		if (gridMode) this.removePseudoclasses();
		this.layout_manager = gridMode ? this._gridLayout : this._boxLayout;
		if (!gridMode) this.updatePseudoclasses();
	}

	private updateVisible() {
		const n = get_n_visible_children(this);
		if (n === 0) {
			this.add_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.CENTER;
			this.x_expand = true;

			if (this.get_n_children() === 1) {
				this._statusItem.state = State.Empty;
			} else {
				this._statusItem.state = State.NoResults;
			}
		} else if (n >= 2 && this._statusItem.get_parent() !== null) {
			this.remove_child(this._statusItem);
			this.x_align = Clutter.ActorAlign.START;
			this.x_expand = false;
		}

		this.updatePseudoclasses();
	}

	private removePseudoclasses(): void {
		(get_first_visible_child(this) as St.Widget | null)?.remove_style_pseudo_class('first-child');
		(get_last_visible_child(this) as St.Widget | null)?.remove_style_pseudo_class('last-child');
	}

	private updatePseudoclasses(): void {
		if (this._gridMode) return;

		(get_first_visible_child(this) as St.Widget | null)?.add_style_pseudo_class('first-child');
		(get_last_visible_child(this) as St.Widget | null)?.add_style_pseudo_class('last-child');
	}

	private nextFocus(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		const newFocus = get_next_visible_sibling(child) ?? get_previous_visible_sibling(child);
		if (newFocus && newFocus !== this._statusItem) {
			this.focusChild(newFocus, animate);
		} else {
			// Navigate to the search entry
			global.focus_manager.get_group(this).grab_key_focus();
		}
	}

	public focusChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		this._lastFocus = child;
		child.grab_key_focus();
		this.scrollToChild(child, animate);
	}

	public scrollToFocus(animate: boolean = true): void {
		for (const child of this.get_children()) {
			if (child.has_key_focus()) {
				this._lastFocus = child;
				this.scrollToChild(child, animate);
				return;
			}
		}
	}

	public scrollToChild(child: Clutter.Actor, animate: boolean = true): void {
		if (child.get_parent() !== this) return;

		const box = child.get_allocation_box();
		let adjustment: St.Adjustment;
		let value: number;
		if (this.scrollOrientation === Clutter.Orientation.HORIZONTAL) {
			adjustment = this.hadjustment;
			value = box.x1 + box.get_width() * 0.5 - adjustment.page_size * 0.5;

			if (this.text_direction === Clutter.TextDirection.RTL) {
				value = adjustment.get_upper() - adjustment.page_size - value;
			}
		} else {
			adjustment = this.vadjustment;
			value = box.y1 + box.get_height() * 0.5 - adjustment.page_size * 0.5;
		}

		if (animate) {
			adjustment.ease(value, { duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
		} else {
			adjustment.value = value;
		}
	}

	public addItem(item: ClipboardItem): void {
		// An entry must never be shown twice. A duplicate means the history was loaded again before
		// the previous items were cleared, which is what made pinned and tagged entries multiply.
		if (this.findItem(item.entry.id)) return;

		this.insertOrMoveItem(item, true, true);
		this.setupItemHandlers(item);
	}

	/**
	 * Add an item in batch mode (does not update visibility immediately).
	 * Must be followed by finishBatch() to update visibility.
	 */
	public addItemBatch(item: ClipboardItem): void {
		// An entry must never be shown twice. A duplicate means the history was loaded again before
		// the previous items were cleared, which is what made pinned and tagged entries multiply.
		if (this.findItem(item.entry.id)) return;

		this.insertOrMoveItem(item, true, false);
		this.setupItemHandlers(item);
	}

	/**
	 * Finish batch loading and update visibility for all queued items.
	 */
	public finishBatch(): void {
		// A remembered search query has to be applied to the items that were added with per-item
		// search skipped, otherwise the restored query would show entries it does not match.
		if (this._lastQuery) this.search(this._lastQuery);
		else this.updateVisible();
	}

	private setupItemHandlers(item: ClipboardItem): void {
		// The handlers are owned by the item so they are dropped together with it, both when the item
		// is destroyed and when it is removed from the container.
		item.entry.connectObject(
			// Move item when datetime changes
			'notify::datetime',
			() => this.insertOrMoveItem(item, false),

			// Delete item when deleted
			'delete',
			() => this.removeItem(item),

			// Pinning changes both the sort position and whether exclude-pinned hides the item, so the
			// search has to be re-applied either way.
			'notify::pinned',
			() => {
				if (this._ext.settings.get_boolean('pinned-on-top')) this.insertOrMoveItem(item);
				else this.updateSearch(item);
			},

			// Update search only when properties used by search can change.
			'notify::content',
			() => this.updateSearch(item),
			'notify::tag',
			() => this.updateSearch(item),
			'notify::type',
			() => this.updateSearch(item),
			'notify::metadata',
			() => this.updateSearch(item),
			'notify::title',
			() => this.updateSearch(item),
			item,
		);
	}

	/**
	 * Re-orders every item, for when the sort criteria themselves change.
	 *
	 * Toggling pinned-on-top leaves the existing children in datetime order, which is not partitioned
	 * by pinned state, so incremental insertion alone would never produce the right order.
	 */
	public resortItems(): void {
		const items = this.get_children().filter((c) => c instanceof ClipboardItem);
		for (const item of items) this.insertOrMoveItem(item, false, false);

		if (this._lastQuery) this.search(this._lastQuery);
		else this.updateVisible();
	}

	private findItem(id: number): ClipboardItem | null {
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem && child.entry.id === id) return child;
		}

		return null;
	}

	/**
	 * The grid reads the cells straight off the list of children, so sorting stays a matter of
	 * putting the item at the right child index, exactly like it is for a single line.
	 */
	private insertOrMoveItem(item: ClipboardItem, search: boolean = true, updateVisibility: boolean = true): void {
		this.removePseudoclasses();

		if (item.get_parent() === this) this.remove_child(item);

		const pinnedOnTop = this._ext.settings.get_boolean('pinned-on-top');

		let i = 0;
		for (const c of this.get_children()) {
			if (c instanceof ClipboardItem) {
				// Compare pinned status first if pinned-on-top is enabled
				if (pinnedOnTop) {
					const itemIsPinned = item.entry.pinned;
					const childIsPinned = c.entry.pinned;

					// If item is pinned and child is not, insert before child
					if (itemIsPinned && !childIsPinned) {
						this.insert_child_at_index(item, i);
						break;
					}

					// If both have same pinned status, compare by datetime
					if (itemIsPinned === childIsPinned && c.entry.datetime.compare(item.entry.datetime) <= 0) {
						this.insert_child_at_index(item, i);
						break;
					}
				} else {
					// Original behavior: sort by datetime only
					if (c.entry.datetime.compare(item.entry.datetime) <= 0) {
						this.insert_child_at_index(item, i);
						break;
					}
				}
			}
			i++;
		}

		if (i === this.get_n_children()) {
			this.add_child(item);
		}

		if (!updateVisibility) return;

		if (search && this._lastQuery) {
			this.updateSearch(item);
		} else {
			this.updateVisible();
		}
	}

	public clearItems(): void {
		let focus = false;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem) {
				focus ||= child.has_key_focus();
				child.entry.disconnectObject(child);
				this.remove_child(child);
			}
		}
		this.updateVisible();

		if (focus) {
			// Navigate to the search entry
			global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
		}
	}

	public removeItem(child: ClipboardItem): void {
		if (child.get_parent() !== this) return;

		const hasKeyFocus = child.has_key_focus();
		let newFocus = null;
		if (hasKeyFocus) {
			newFocus = get_next_visible_sibling(child) ?? get_previous_visible_sibling(child);
		}

		child.entry.disconnectObject(child);
		this.remove_child(child);
		this.updateVisible();

		if (hasKeyFocus) {
			if (newFocus && newFocus !== this._statusItem) {
				this.focusChild(newFocus);
			} else {
				this._lastFocus = null;

				// Navigate to the search entry
				global.focus_manager.get_group(this).navigate_focus(this, St.DirectionType.UP, true);
			}
		}
	}

	public selectItem(index: number): boolean {
		let i = 0;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem && child.visible) {
				if (i === index) {
					this.focusChild(child);
					return true;
				}

				i++;
			}
		}

		return false;
	}

	public selectNextItem() {
		let focusChild: ClipboardItem | null = null;

		for (const child of this.get_children()) {
			if (focusChild === null && child instanceof ClipboardItem && child.visible) {
				focusChild = child;
			}

			if (child.has_key_focus()) {
				this.nextFocus(child);
				return;
			}
		}

		if (focusChild !== null) {
			this.focusChild(focusChild);
		}
	}

	public search(query: SearchQuery): void {
		// Copy search query, but with SearchChange.Different to always force re-search
		this._lastQuery = query.withChange(SearchChange.Different);

		this.removePseudoclasses();
		let focusChild: ClipboardItem | null = null;
		let firstVisible: ClipboardItem | null = null;
		for (const child of this.get_children()) {
			if (child instanceof ClipboardItem) {
				const hasFocus = child.has_key_focus();
				child.search(query);
				if (hasFocus) focusChild = child;
				if (child.visible && firstVisible === null) firstVisible = child;
			}
		}
		this.updateVisible();

		if (focusChild && focusChild.visible) {
			this.focusChild(focusChild, false);
		} else if (this._lastFocus && this._lastFocus.visible) {
			this.scrollToChild(this._lastFocus, false);
		} else if (firstVisible !== null) {
			this.focusChild(firstVisible, false);
		}
	}

	private updateSearch(item: ClipboardItem): void {
		if (!this._lastQuery) return;

		const hasKeyFocus = item.has_key_focus();
		this.removePseudoclasses();
		item.search(this._lastQuery);
		this.updateVisible();
		if (hasKeyFocus && !item.visible) this.nextFocus(item, false);
	}

	public activateFirst(): void {
		const first = get_first_visible_child(this);
		if (first instanceof St.Button) {
			first.vfunc_clicked(1);
		}
	}

	/**
	 * Moves the focus inside the grid.
	 *
	 * The arrow keys along the fill axis step by one item, so they follow the child order and wrap
	 * from the end of a line to the start of the next one. The arrow keys across the fill axis step
	 * by a whole line, which is the same item of the previous or the next line. Tab keeps stepping
	 * by one item in either direction, whatever the orientation is.
	 */
	private navigateGrid(from: Clutter.Actor, direction: St.DirectionType): boolean {
		const horizontal = this._orientation === Clutter.Orientation.HORIZONTAL;
		const line = this._gridLayout.itemsPerLine;

		let offset: number;
		switch (direction) {
			case St.DirectionType.TAB_FORWARD:
				offset = 1;
				break;
			case St.DirectionType.TAB_BACKWARD:
				offset = -1;
				break;
			case St.DirectionType.RIGHT:
				offset = horizontal ? 1 : line;
				break;
			case St.DirectionType.LEFT:
				offset = horizontal ? -1 : -line;
				break;
			case St.DirectionType.DOWN:
				offset = horizontal ? line : 1;
				break;
			case St.DirectionType.UP:
				offset = horizontal ? -line : -1;
				break;
			default:
				return Clutter.EVENT_PROPAGATE;
		}

		let target = get_visible_sibling(from, offset);

		// Stepping a whole line forward from the last, partially filled line lands past the end.
		// Falling back to the last item keeps that line one key press away.
		if (target === null && offset > 1) {
			const last = get_last_visible_child(this);
			if (last !== null && last !== from) target = last;
		}

		if (target !== null && target !== this._statusItem) {
			this.focusChild(target);
			return Clutter.EVENT_STOP;
		}

		// Leaving the grid backwards reaches the search entry, leaving it forwards reaches the
		// footer, which only exists in the vertical orientation.
		if (offset < 0 || direction === St.DirectionType.TAB_FORWARD || !horizontal) {
			this._lastFocus = from;
			return Clutter.EVENT_PROPAGATE;
		}

		return Clutter.EVENT_STOP;
	}

	override vfunc_navigate_focus(from: Clutter.Actor | null, direction: St.DirectionType): boolean {
		// Navigation from the search entry
		if (from?.get_parent() !== this) {
			// If tab navigation is used, then focus on first or last child
			if (direction === St.DirectionType.TAB_FORWARD || direction === St.DirectionType.TAB_BACKWARD) {
				this._lastFocus = null;
				const child =
					direction === St.DirectionType.TAB_BACKWARD
						? get_last_visible_child(this)
						: get_first_visible_child(this);
				if (child !== this._statusItem) {
					this._lastFocus = child;
				}
			}

			// If the last focus is null or not visible, then focus the first visible child
			if (this._lastFocus === null || !this._lastFocus.visible || this._lastFocus.get_parent() !== this) {
				this._lastFocus = null;
				const child = get_first_visible_child(this);
				if (child !== this._statusItem) {
					this._lastFocus = child;
				}
			}

			// Navigate to the search entry
			if (!this._lastFocus) return Clutter.EVENT_PROPAGATE;

			this._lastFocus.grab_key_focus();
			this.scrollToChild(this._lastFocus);
			return Clutter.EVENT_STOP;
		}

		// The focus moves through a grid by cell, which is not the same as by sibling for the two
		// directions across the fill axis.
		if (this._gridMode) return this.navigateGrid(from, direction);

		const first = get_first_visible_child(this);
		const last = get_last_visible_child(this);
		if (this.orientation === Clutter.Orientation.HORIZONTAL) {
			// If up or shift tab navigation then focus the search entry
			if (direction === St.DirectionType.UP) {
				this._lastFocus = from;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore down navigation
			if (direction === St.DirectionType.DOWN) {
				return Clutter.EVENT_STOP;
			}
		} else {
			// If on the first child then focus the search entry
			if (from === first && direction === St.DirectionType.UP) {
				this._lastFocus = from;
				// Navigate to the search entry
				return Clutter.EVENT_PROPAGATE;
			}

			// If on the last child then focus on footer
			if (from === last && direction === St.DirectionType.DOWN) {
				this._lastFocus = from;
				return Clutter.EVENT_PROPAGATE;
			}

			// Ignore left and right navigation
			if (direction === St.DirectionType.LEFT || direction === St.DirectionType.RIGHT) {
				return Clutter.EVENT_STOP;
			}
		}

		// If on first child and shift tab navigation then focus the search entry
		if (from === first && direction === St.DirectionType.TAB_BACKWARD) {
			this._lastFocus = from;
			// Navigate to the search entry
			return Clutter.EVENT_PROPAGATE;
		}

		// If on last child and tab navigation then focus the footer
		if (from === last && direction === St.DirectionType.TAB_FORWARD) {
			this._lastFocus = from;
			// Navigate to footer
			return Clutter.EVENT_PROPAGATE;
		}

		// Otherwise map navigation to tab navigation due to weird behavior for a larger number of items
		const tabDirection =
			direction === St.DirectionType.TAB_FORWARD ||
			direction === St.DirectionType.RIGHT ||
			direction === St.DirectionType.DOWN
				? St.DirectionType.TAB_FORWARD
				: St.DirectionType.TAB_BACKWARD;
		const res = super.vfunc_navigate_focus(from, tabDirection);
		this.scrollToFocus();
		return res;
	}

	override vfunc_style_changed(): void {
		// St.BoxLayout forwards the spacing CSS property to its layout manager, St.Viewport does
		// not, so the container has to do it itself for both of its layouts.
		this._spacing = Math.round(this.get_theme_node().get_length('spacing'));
		this._boxLayout.spacing = this._spacing;
		this._gridLayout.spacing = this._spacing;

		super.vfunc_style_changed();
	}

	override vfunc_map(): void {
		this._lastFocus = null;
		this.hadjustment.value = 0;
		this.vadjustment.value = 0;

		super.vfunc_map();
	}
}
