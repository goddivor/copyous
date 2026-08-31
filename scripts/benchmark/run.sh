#!/usr/bin/env bash
# Repeatable open-latency benchmark for the clipboard dialog.
#
# Runs the extension inside a nested gnome-shell against a committed fixture and reports how long
# Show() blocks the shell's main loop, for an empty history and for a large one.
#
# Usage: scripts/benchmark/run.sh [entry counts...]   (default: 0 1000)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
COUNTS=("${@:-}")
[ -z "${COUNTS[0]:-}" ] && COUNTS=(0 1000)
WARM_ITERATIONS="${WARM_ITERATIONS:-10}"

SHELL_PID=""
DBUS_PID=""

cleanup() {
	[ -n "$SHELL_PID" ] && kill "$SHELL_PID" 2>/dev/null || true
	[ -n "$DBUS_PID" ] && kill "$DBUS_PID" 2>/dev/null || true
	rm -rf "$WORK"
}
trap cleanup EXIT

command -v gnome-shell >/dev/null || { echo "gnome-shell is not installed" >&2; exit 1; }
command -v gjs >/dev/null || { echo "gjs is not installed" >&2; exit 1; }

# A nested shell needs a host display; without one, fall back to mutter's headless backend.
NESTED_ARGS=(--wayland)
if [ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]; then
	NESTED_ARGS+=(--nested)
else
	NESTED_ARGS+=(--headless --virtual-monitor 1920x1080)
fi

echo "Building and installing the extension..." >&2
make -C "$ROOT" install >/dev/null

printf '\n%-10s %14s %14s %14s\n' "entries" "cold open" "warm median" "warm worst"
printf '%-10s %14s %14s %14s\n' "-------" "---------" "-----------" "----------"

for count in "${COUNTS[@]}"; do
	fixture="$WORK/clipboard-$count.json"
	pnpm --dir "$ROOT" exec tsx "$ROOT/scripts/benchmark/generate-fixture.ts" "$count" "$fixture" 2>/dev/null

	# Each run gets a private session bus so the nested shell never talks to the real one.
	bus_output="$(dbus-daemon --session --fork --print-address --print-pid)"
	DBUS_SESSION_BUS_ADDRESS="$(echo "$bus_output" | sed -n 1p)"
	DBUS_PID="$(echo "$bus_output" | sed -n 2p)"
	export DBUS_SESSION_BUS_ADDRESS

	DEBUG_COPYOUS_DBPATH="$fixture" \
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080 \
		gnome-shell "${NESTED_ARGS[@]}" >"$WORK/shell-$count.log" 2>&1 &
	SHELL_PID=$!

	# Enable the extension in the nested session once the shell is up.
	( sleep 6; gnome-extensions enable copyous@boerdereinar.dev >/dev/null 2>&1 || true ) &

	if result="$(gjs "$ROOT/scripts/benchmark/client.js" "$WARM_ITERATIONS" 2>"$WORK/client-$count.log")"; then
		cold="$(echo "$result" | sed -E 's/.*"cold":([0-9.]+).*/\1/')"
		median="$(echo "$result" | sed -E 's/.*"warmMedian":([0-9.]+).*/\1/')"
		worst="$(echo "$result" | sed -E 's/.*"warmWorst":([0-9.]+).*/\1/')"
		printf '%-10s %13.1fms %13.1fms %13.1fms\n' "$count" "$cold" "$median" "$worst"
	else
		printf '%-10s %14s %14s %14s\n' "$count" "failed" "-" "-"
		echo "  client log: $WORK/client-$count.log" >&2
		cat "$WORK/client-$count.log" >&2
	fi

	kill "$SHELL_PID" 2>/dev/null || true
	wait "$SHELL_PID" 2>/dev/null || true
	SHELL_PID=""
	kill "$DBUS_PID" 2>/dev/null || true
	DBUS_PID=""
done

echo
echo "Note: the numbers are how long the synchronous Show() D-Bus call blocks the shell's main loop." >&2
echo "They are comparable between runs on the same machine, not between machines." >&2
