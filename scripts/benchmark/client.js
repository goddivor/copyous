#!/usr/bin/env gjs
// Measures how long the extension blocks the shell's main loop when the clipboard dialog is opened.
//
// Show() is a synchronous D-Bus method handled on the shell's main thread, so the method call does
// not return until the shell is done with everything open() does before yielding. That is precisely
// the work the freeze reports are about, which is what makes the round trip a meaningful number
// rather than a proxy for one.
//
// Usage: gjs scripts/benchmark/client.js <warm iterations>

imports.gi.versions.Gio = '2.0';
const { Gio, GLib } = imports.gi;

const NAME = 'org.gnome.Shell.Extensions.Copyous';
const PATH = '/org/gnome/Shell/Extensions/Copyous';
const IFACE = 'org.gnome.Shell.Extensions.Copyous';

const warmIterations = Number(ARGV[0] ?? '10');

const bus = Gio.DBus.session;

function call(method) {
	const start = GLib.get_monotonic_time();
	bus.call_sync(NAME, PATH, IFACE, method, null, null, Gio.DBusCallFlags.NONE, 30000, null);
	return (GLib.get_monotonic_time() - start) / 1000;
}

// Wait for the extension to own its name. The shell needs a moment to come up.
printerr(`waiting for ${NAME} on the bus...`);
let owned = false;
for (let i = 0; i < 120; i++) {
	try {
		bus.call_sync(
			'org.freedesktop.DBus',
			'/org/freedesktop/DBus',
			'org.freedesktop.DBus',
			'GetNameOwner',
			new GLib.Variant('(s)', [NAME]),
			null,
			Gio.DBusCallFlags.NONE,
			1000,
			null,
		);
		owned = true;
		break;
	} catch {
		GLib.usleep(500000);
	}
}

if (!owned) {
	printerr(`${NAME} never appeared on the bus`);
	imports.system.exit(1);
}

// The name appears as soon as enable() runs. Give the history load a moment to settle so the cold
// open measures the first user-visible open rather than racing the startup work.
GLib.usleep(2000000);

const cold = call('Show');
call('Hide');
GLib.usleep(500000);

const warm = [];
for (let i = 0; i < warmIterations; i++) {
	warm.push(call('Show'));
	call('Hide');
	GLib.usleep(300000);
}

warm.sort((a, b) => a - b);
const median = warm.length ? warm[Math.floor(warm.length / 2)] : 0;
const worst = warm.length ? warm[warm.length - 1] : 0;

print(JSON.stringify({ cold, warmMedian: median, warmWorst: worst, warm }));
