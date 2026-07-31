## Local Process Control

### Overview

Start, stop, and monitor local processes on the machine Companion is running on — desktop tools,
game launchers, Flatpak apps, anything you'd otherwise start by hand or with a shell-command/polling
workaround.

### Configuration

There's a single config field: **Managed Tools (JSON)**, a JSON array describing every tool you want
to control. Each entry:

- `id` (required): Unique identifier, used internally. Not shown anywhere in the Companion UI.
- `label` (required): Shown in the action/feedback dropdowns.
- `path` (required): Executable to run.
- `args` (optional): Array of string arguments.
- `cwd` (optional): Working directory.
- `flatpakAppId` (optional): Set this if `path` launches the tool via `flatpak run`. See below.
- `processMatch` (optional): Set this for launchers that exit right after starting the real,
  longer-lived process (self-updaters, Steam games, etc). See below.

Example:

```json
[
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

Saving the config immediately rebuilds the action and feedback dropdowns from the new tool list.

#### Flatpak apps

`flatpak run` exits as soon as it hands off to the sandboxed app — it doesn't stay running for the
life of the app. If you leave `flatpakAppId` unset for a Flatpak-launched tool, Stop won't actually
stop it and the running feedback will go wrong shortly after launch. Set `flatpakAppId` to the app's
Flatpak ID (the same ID you pass to `flatpak run`) to fix both: stop uses `flatpak kill`, and running
state is tracked via `flatpak ps` instead of the process handle.

#### Launchers that hand off to another process

Some tools exit their initial launched process shortly after starting the real one — a Steam game
launched via the Steam client, a self-updating app that re-execs into the updated binary, etc. If
Stop isn't working and/or the running feedback isn't tracking correctly for a tool like this, set
`processMatch` to a substring that's unique to the real process's command line (check with `ps aux`
while it's running — the full path or a distinctive argument usually works well). The module will
scan running processes for that substring to determine running state, and send a stop signal
directly to any matching process id.

### Actions

- **Start Process** — starts the selected tool, if it isn't already running.
- **Stop Process** — stops the selected tool, if it's running and was either started by this module
  or matched via `flatpakAppId`/`processMatch`. Tools running externally with no such handle can't be
  stopped from here (a warning is logged instead).
- **Toggle Process** — Start if not running, Stop if running.

### Feedback

- **Process Running** — boolean feedback per tool. Updates instantly for anything this module
  launched directly (on the process's own start/exit), and within a few seconds for tools running
  externally, via Flatpak, or via `processMatch`, all of which are checked on a background poll.

### Notes

- If Companion runs headless (e.g. as a systemd user service), GUI tools need `DISPLAY`/
  `WAYLAND_DISPLAY`/etc. to open a window. This module fetches those from the desktop session
  (`systemctl --user show-environment`) before launching anything, so this should just work — but if
  a GUI tool crashes immediately on start, check that this machine actually has a desktop session
  running and that value is populated.
- Only one instance of each tool is tracked at a time; Start is a no-op if the tool is already
  detected as running.
