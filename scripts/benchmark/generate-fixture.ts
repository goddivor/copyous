/**
 * Generates a deterministic clipboard history fixture for the open-latency benchmark.
 *
 * The output is a JSON database in the format written by src/lib/database/json.ts, so it can be
 * pointed at with DEBUG_COPYOUS_DBPATH without going through the extension.
 *
 * Usage: pnpm tsx scripts/benchmark/generate-fixture.ts <entries> <output.json>
 */
import { writeFileSync } from 'node:fs';

const ItemType = {
	Text: 'Text',
	Code: 'Code',
	Link: 'Link',
	Character: 'Character',
	Color: 'Color',
} as const;

const Tags = ['blue', 'teal', 'green', 'yellow', 'orange', 'red', 'pink', 'purple', 'slate'] as const;

interface JsonClipboardEntry {
	type: string;
	content: string;
	pinned: boolean;
	tag: string | null;
	datetime: string;
	metadata: null;
	title: string | undefined;
}

/**
 * xorshift32. Node has no seedable Math.random, and the fixture has to be byte-identical between
 * runs for a before/after comparison to mean anything.
 */
function makeRandom(seed: number): () => number {
	let state = seed || 1;
	return () => {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;
		return (state >>> 0) / 0x100000000;
	};
}

const WORDS = [
	'clipboard', 'history', 'entry', 'paste', 'select', 'window', 'buffer', 'search',
	'pinned', 'tagged', 'shell', 'extension', 'session', 'preview', 'content', 'value',
];

function makeContent(type: string, random: () => number, index: number): string {
	switch (type) {
		case ItemType.Code:
			return [
				`function entry${index}(value) {`,
				`\tconst total = value * ${Math.floor(random() * 100)};`,
				'\treturn total > 0 ? total : 0;',
				'}',
			].join('\n');
		case ItemType.Link:
			return `https://example.com/entry/${index}?ref=benchmark`;
		case ItemType.Character:
			return String.fromCodePoint(0x1f300 + (index % 128));
		case ItemType.Color:
			return `#${Math.floor(random() * 0xffffff)
				.toString(16)
				.padStart(6, '0')}`;
		default: {
			const length = 4 + Math.floor(random() * 40);
			const words = [];
			for (let i = 0; i < length; i++) words.push(WORDS[Math.floor(random() * WORDS.length)]);
			return `${index}: ${words.join(' ')}`;
		}
	}
}

function generate(count: number): { version: number; entries: JsonClipboardEntry[] } {
	const random = makeRandom(0x5eed);
	const types = Object.values(ItemType);

	// Fixed base date, so the fixture does not change from one day to the next.
	const base = Date.UTC(2026, 0, 1, 0, 0, 0);

	const entries: JsonClipboardEntry[] = [];
	for (let i = 0; i < count; i++) {
		const type = types[Math.floor(random() * types.length)]!;

		// Every 10th entry is pinned and every 17th is tagged, so the fixture also exercises the
		// entries that history-length does not bound.
		entries.push({
			type,
			content: makeContent(type, random, i),
			pinned: i % 10 === 0,
			tag: i % 17 === 0 ? Tags[i % Tags.length]! : null,
			datetime: new Date(base + i * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
			metadata: null,
			title: undefined,
		});
	}

	return { version: 2, entries };
}

const [countArg, output] = process.argv.slice(2);
if (!countArg || !output) {
	console.error('usage: generate-fixture.ts <entries> <output.json>');
	process.exit(1);
}

const count = Number(countArg);
if (!Number.isInteger(count) || count < 0) {
	console.error(`invalid entry count: ${countArg}`);
	process.exit(1);
}

writeFileSync(output, JSON.stringify(generate(count)));
console.error(`wrote ${count} entries to ${output}`);
