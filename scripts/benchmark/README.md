# Open-latency benchmark

Repeatable measurement of how long opening the clipboard dialog blocks gnome-shell's main loop,
so performance changes can report before/after numbers instead of impressions.

## Running

```sh
make benchmark                          # 0 and 1000 entries
make benchmark BENCHMARK_ENTRIES="0 100 1000 5000"
WARM_ITERATIONS=20 make benchmark
```

Output:

```
entries         cold open    warm median     warm worst
-------         ---------    -----------     ----------
0                   41.2ms         12.7ms         18.3ms
1000              2314.8ms        486.1ms        712.5ms
```

## What is measured

`Show()` is a synchronous D-Bus method handled on the shell's main thread. The call does not return
until the shell is done with everything `open()` does before it yields, which is exactly the work
the freeze reports are about. The round trip is therefore a direct measurement of the block, not a
proxy for one.

- **cold open** — the first open of a fresh session, after the history has been loaded.
- **warm median / worst** — the following opens, which is what a user experiences during a session.

## What is not measured

- Time to first painted frame. The dialog animates for 150ms after `open()` returns, and this
  harness does not observe the compositor.
- The startup cost itself. A history that blocks `enable()` shows up as a slow *cold* open here,
  but the login freeze it causes is not timed separately.
- Anything comparable across machines. Only compare runs on the same machine, same session.

## The fixture

`generate-fixture.ts` writes a JSON database in the format of `src/lib/database/json.ts`, seeded
with a fixed value so two runs get byte-identical input. Every 10th entry is pinned and every 17th
is tagged, because `history-length` does not bound those and they are what the reported histories
actually accumulate.

The fixture is generated on the fly rather than committed: it is deterministic from the seed, and a
5000-entry file is large enough that committing it would not be worth the repository weight.

## Requirements

`gnome-shell`, `gjs`, `dbus-daemon`, and a built extension (`make install`, run automatically).
With a host display the shell runs nested; without one it falls back to mutter's headless backend.
