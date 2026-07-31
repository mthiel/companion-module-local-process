# companion-module-local-process

A [Bitfocus Companion](https://bitfocus.io/companion) module for starting, stopping, and monitoring
local processes on the machine Companion runs on — desktop tools, launchers, Flatpaks, even other
Steam games — without polling shell commands or `pkill`-matching by name.

See [HELP.md](./companion/HELP.md) and [LICENSE](./LICENSE).

## Why this exists

Companion's built-in "Run Shell Command" action plus an interval trigger can start/stop a process and
poll its state into a variable, but that approach has real problems: feedback only updates on the next
poll tick (visible lag after pressing a button), stopping requires `pkill`-style name matching that's
fragile with multiple or similarly-named instances, and every managed tool means another shell spawn on
every tick, forever.

This module instead holds each process it launches as an in-memory handle. Stopping a directly-launched
tool is a direct kill, and feedback updates the moment the process actually starts or exits — not on a
timer.

## Features

- **Start Process** / **Stop Process** / **Toggle Process** actions, each a dropdown of your configured tools
- **Process Running** boolean feedback, per tool
- Instant feedback for anything this module launched (updates on the process's own `spawn`/`exit`, not a poll)
- A background fallback check (every 5s) for tools that are running but weren't started by Companion —
  e.g. launched manually, or by something else
- First-class handling for two cases where "just track the child process" doesn't work (see below):
  Flatpak apps, and launchers that hand off to a different, longer-lived process

## Configuration

Managed tools are configured as a single JSON array (there's no native repeating-field widget in the
Companion config API for this, so it's a JSON textarea). Each entry:

| Field          | Required | Description                                                                                   |
| -------------- | -------- | --------------------------------------------------------------------------------------------- |
| `id`           | Yes      | Unique identifier, used internally (not shown in the UI)                                      |
| `label`        | Yes      | Shown in the action/feedback dropdowns                                                        |
| `path`         | Yes      | Executable to run                                                                             |
| `args`         | No       | Array of string arguments                                                                     |
| `cwd`          | No       | Working directory                                                                             |
| `flatpakAppId` | No       | See [Flatpak apps](#flatpak-apps) below                                                       |
| `processMatch` | No       | See [Launchers that hand off to another process](#launchers-that-hand-off-to-another-process) |

### Example

```json
[
	{
		"id": "elitedangerous",
		"label": "Elite Dangerous",
		"path": "/usr/bin/steam",
		"args": ["-applaunch", "359320"],
		"processMatch": "EliteDangerous64.exe"
	},
	{
		"id": "edmc",
		"label": "E:D Market Connector",
		"path": "/usr/bin/flatpak",
		"args": ["run", "--branch=stable", "--arch=x86_64", "--command=edmarketconnector", "io.edcd.EDMarketConnector"],
		"flatpakAppId": "io.edcd.EDMarketConnector"
	},
	{
		"id": "srvsurvey",
		"label": "SRV Survey",
		"path": "/home/matt/Applications/SrvSurvey",
		"args": []
	}
]
```

(A working set of examples like this lives in [example-tools.json](./example-tools.json).)

Config changes take effect immediately — action/feedback dropdowns are rebuilt from the tool list on
every save.

### Plain executables

For a tool where `path` is the actual long-running process (e.g. `SrvSurvey` above), no extra
configuration is needed: the module holds the `ChildProcess` handle it created, stop is a direct
`.kill()`, and feedback updates on that process's own `exit` event.

### Flatpak apps

`flatpak run` is not a supervisor — it hands off to the sandboxed instance and exits well before the
app itself does, often within a second or two. That means the handle this module gets from spawning
`flatpak run ...` stops being useful almost immediately: killing it doesn't stop the actual app, and
its exit event doesn't mean the app is gone either.

Set `flatpakAppId` to the app's Flatpak ID (e.g. `io.edcd.EDMarketConnector`) and the module switches to
using Flatpak's own tooling for that tool: `flatpak kill <app-id>` to stop it, and a background
`flatpak ps` poll (every 5s) to track whether it's running. `path`/`args` are unchanged — you still
launch it however you normally would via `flatpak run`.

### Launchers that hand off to another process

Some tools (self-updating apps, Steam games, anything with a native launcher stub) exit their initial
process shortly after starting the real, longer-lived one — the same shape of problem as Flatpak, but
without an equivalent `flatpak kill`/`flatpak ps` to fall back on.

Set `processMatch` to a substring that reliably identifies the real process's full command line (check
with `ps aux` while it's running), and the module will:

- use it to detect whether the tool is running, by scanning all processes for that substring, instead
  of relying on the launched executable's own handle
- use it to stop the tool, by finding matching process(es) and sending `SIGTERM` directly to their PIDs

This is the same "match by name" approach a shell-command/`pkill` workaround would use — but scoped to
a single opt-in field per tool, rather than being how every tool is tracked.

## Requirements

- **Linux**, matching this module's assumptions (`systemctl --user`, `/proc`-based process listing via
  [`ps-list`](https://www.npmjs.com/package/ps-list), and optionally `flatpak`). Not tested on
  macOS/Windows.
- Companion's `node22` module runtime with the `child-process` and `filesystem` permissions, already
  declared in [`companion/manifest.json`](./companion/manifest.json) — required for spawning processes
  and for `ps-list`'s `/proc/{pid}/exe` resolution. Companion will refuse to run child-process-spawning
  code without this declared.
- If Companion runs as a systemd user service (headless, no GUI process), it launches each module's
  host process with a stripped-down environment that's missing `DISPLAY`/`WAYLAND_DISPLAY`/
  `DBUS_SESSION_BUS_ADDRESS` — needed for any GUI tool this module launches. Before spawning, the module
  queries `systemctl --user show-environment` (which desktop sessions populate at login) and merges
  those values in. If that command isn't available, tools are still launched, just without those
  variables, and a warning is logged.
- `flatpak` on `PATH` if any tool uses `flatpakAppId`.
- `/bin/sh`. Every tool is launched via `sh -c 'unset NODE_OPTIONS ...; exec "$0" "$@"'` rather than
  invoking `path` directly — Node's permission model, active on the module host per the manifest's
  declared permissions, forcibly re-injects `NODE_OPTIONS` (carrying `--permission`) into every child
  process it spawns, regardless of the `env` passed to `spawn()`. That's harmless for non-Node
  executables, but fatal for a tool that's itself a Node process, since Node refuses to start at all
  with `--permission` set via `NODE_OPTIONS`. The interposed shell unsets it right before `exec`, which
  replaces the process image in place (same pid), so this doesn't change how the resulting process is
  tracked or killed.

## Getting started (development)

Executing a `yarn` command should perform all necessary steps to develop the module, if it does not
then follow the steps below.

The module can be built once with `yarn build`. This should be enough to get the module to be loadable
by Companion.

While developing the module, by using `yarn dev` the compiler will be run in watch mode to recompile the
files on change.
