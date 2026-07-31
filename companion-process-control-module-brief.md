# Bitfocus Companion Module: Local Process Control

## Goal

Build a custom Bitfocus Companion module that adds Start / Stop / Toggle actions and
a "running" feedback for local external tools (used alongside Elite Dangerous),
replacing a polling/shell-command workaround with direct process management.

## Environment

- Fedora Linux desktop (KDE Plasma)
- Companion runs headless as a systemd user service, invoking the underlying
  Node process directly (not the Electron `companion-launcher` GUI build) —
  this was changed specifically because the Electron launcher didn't shut down
  cleanly under systemd.
- Companion admin UI: `http://127.0.0.1:8000`, config dir `~/.config/companion/`
- Companion is already launched with `--extra-module-path=/home/matt/src/companion/modules/`,
  so locally-developed modules under that path load without extra config.
- A new module project has already been scaffolded (via the official
  `companion-module-tools` template) in a project folder open in VS Code —
  this is the project to build out. The project folder is at `~/src/companion/modules/companion-module-local-process/`

## Why a module instead of the shell-command/polling approach

Discussed and rejected: using Companion's generic "Run Shell Command" action to
start/stop processes, paired with an interval trigger that polls process state
into a custom variable for feedback. Problems with that approach:

- Feedback only updates on the next poll tick (visible lag after pressing a button)
- Stopping a process requires name-based matching (`pkill`-style), which is
  fragile if multiple instances or similarly-named processes exist
- N managed processes = N shell spawns every interval tick, indefinitely

A real module can hold each launched process as an in-memory `ChildProcess`
handle, making stop trivial (`.kill()` on the handle) and feedback instant
(update on the process's `exit` event, not on a timer).

## Module design

**Config**

- A list of managed tools, each with: label, executable path, arguments, working directory

**Actions**

- `Start Process` — dropdown of configured tools
- `Stop Process` — dropdown of configured tools
- `Toggle Process` — dropdown of configured tools

**Internal state**

- `Map<string, ChildProcess>` keyed by the tool's configured id, populated on start,
  cleared on the child's `exit` event

**Feedback**

- `Process Running` (boolean) — dropdown of configured tools, checked against the
  in-memory map (not polled)
- On `spawn`/`exit` of a tracked child, call `this.checkFeedbacks('process_running')`
  so the button updates immediately

**Edge case: externally-launched processes**
Some tools may be started outside Companion (manually, or by some other means),
so the module won't have a `ChildProcess` handle for them. For tools not
currently tracked as Companion-launched children only, fall back to a
lightweight in-process check on a modest interval (a few seconds) using the
`ps-list` npm package (reads `/proc` directly) rather than shelling out to
`pgrep`/`ps`.

## Companion module API notes (for reference)

- Base class: `InstanceBase` from `@companion-module/base`
- Config fields: `getConfigFields()`
- Config changes: `configUpdated()` (async)
- Feedback refresh: `this.checkFeedbacks('feedback_id_1', 'feedback_id_2', ...)`
  — accepts multiple feedback ids in one call
- Scaffolding/build tooling: `companion-module-tools` package

## Suggested build order

1. Get the scaffolded template running and loading in Companion via the existing
   `--extra-module-path`
2. Implement config fields for the tool list
3. Implement `Start Process` / `Stop Process` actions using `child_process.spawn`
   and the in-memory map
4. Implement `Process Running` feedback wired to child `exit` events
5. Add `Toggle Process` action
6. Add the `ps-list`-based fallback check for externally-launched processes
