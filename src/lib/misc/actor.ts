import Clutter from 'gi://Clutter';

/**
 * Retrieves the number of visible children of `actor`.
 * @param actor The actor to get the number of visible children of.
 * @returns the number of visible children.
 */
export function get_n_visible_children(actor: Clutter.Actor): number {
	let n = 0;
	for (const child of actor.get_children()) {
		if (child.visible) {
			n++;
		}
	}
	return n;
}

/**
 * Retrieves the first visible sibling of `actor` that comes after it in the list of children of `actor`'s parent.
 * @param actor The actor to get the next visible sibling of.
 * @returns the first visible sibling or null.
 */
export function get_next_visible_sibling(actor: Clutter.Actor): Clutter.Actor | null {
	let next = actor.get_next_sibling();
	while (next !== null && !next.visible) {
		next = next.get_next_sibling();
	}
	return next;
}

/**
 * Retrieves the first visible sibling of `actor` that comes before it in the list of children of `actor`'s parent.
 * @param actor The actor to get the previous visible sibling of.
 * @returns the first visible sibling or null.
 */
export function get_previous_visible_sibling(actor: Clutter.Actor): Clutter.Actor | null {
	let previous = actor.get_previous_sibling();
	while (previous !== null && !previous.visible) {
		previous = previous.get_previous_sibling();
	}
	return previous;
}

/**
 * Retrieves the first visible child of `actor`.
 * @param actor The actor to get the first visible child of.
 * @returns the first visible child or null.
 */
export function get_first_visible_child(actor: Clutter.Actor): Clutter.Actor | null {
	const first = actor.get_first_child();
	if (first === null) {
		return null;
	}
	return first.visible ? first : get_next_visible_sibling(first);
}

/**
 * Retrieves the last visible child of `actor`.
 * @param actor The actor to get the last visible child of.
 * @returns the last visible child or null.
 */
export function get_last_visible_child(actor: Clutter.Actor): Clutter.Actor | null {
	const last = actor.get_last_child();
	if (last === null) {
		return null;
	}
	return last.visible ? last : get_previous_visible_sibling(last);
}

/**
 * Retrieves the visible sibling of `actor` that is `offset` positions away from it in the list of
 * visible children of `actor`'s parent.
 * @param actor The actor to get the visible sibling of.
 * @param offset How many visible siblings to step over, negative to step backwards.
 * @returns the visible sibling or null when there are fewer visible siblings left than `offset`.
 */
export function get_visible_sibling(actor: Clutter.Actor, offset: number): Clutter.Actor | null {
	if (offset === 0) return null;

	const step = offset < 0 ? get_previous_visible_sibling : get_next_visible_sibling;

	let sibling: Clutter.Actor | null = actor;
	for (let i = Math.abs(offset); i > 0 && sibling !== null; i--) {
		sibling = step(sibling);
	}

	return sibling;
}
