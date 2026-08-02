import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import psList from 'ps-list'
import { GetConfigFields, ParseManagedTools, type ManagedTool, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions, type VariablesSchema } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions, type ActionsSchema } from './actions.js'
import { UpdateFeedbacks, type FeedbacksSchema } from './feedbacks.js'
import { UpdatePresets } from './presets.js'

export type ModuleSchema = {
	config: ModuleConfig
	secrets: undefined
	actions: ActionsSchema
	feedbacks: FeedbacksSchema
	variables: VariablesSchema
}

export { UpgradeScripts }

// How often to check for tools that are running but weren't launched by this module.
const EXTERNAL_POLL_INTERVAL_MS = 5000
// How much trailing stderr output to keep (and log) per launched process, in case it fails on startup.
const STDERR_TAIL_MAX_LENGTH = 4000

const execFileAsync = promisify(execFile)

export default class ModuleInstance extends InstanceBase<ModuleSchema> {
	config!: ModuleConfig // Setup in init()

	private tools: ManagedTool[] = []
	// Companion-launched children, keyed by tool id. Presence here is authoritative for non-Flatpak tools.
	private readonly processes = new Map<string, ChildProcess>()
	// Tools last seen running via the ps-list poll but with no ChildProcess handle (started outside Companion).
	private readonly externallyRunning = new Set<string>()
	// Flatpak app ids last seen running via `flatpak ps`. Authoritative for any tool with flatpakAppId set.
	private readonly runningFlatpakApps = new Set<string>()
	// Systemd user units last seen active via `systemctl --user is-active`. Authoritative for systemdUnit tools.
	private readonly runningSystemdUnits = new Set<string>()
	private pollTimer: ReturnType<typeof setInterval> | undefined

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		this.applyToolConfig()

		this.updateStatus(InstanceStatus.Ok)

		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.updateVariableDefinitions()

		this.pollTimer = setInterval(() => {
			this.pollExternalProcesses().catch((e) => {
				this.log('debug', `External process poll failed: ${e instanceof Error ? e.message : String(e)}`)
			})
			this.pollFlatpakApps().catch((e) => {
				this.log('debug', `Flatpak instance poll failed: ${e instanceof Error ? e.message : String(e)}`)
			})
			this.pollSystemdUnits().catch((e) => {
				this.log('debug', `Systemd unit poll failed: ${e instanceof Error ? e.message : String(e)}`)
			})
		}, EXTERNAL_POLL_INTERVAL_MS)
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = undefined
		}
		// Processes were spawned detached/unref'd so they outlive this instance; just drop our references.
		for (const child of this.processes.values()) {
			child.removeAllListeners()
		}
		this.log('debug', 'destroy')
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		this.applyToolConfig()

		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}

	getManagedTools(): ManagedTool[] {
		return this.tools
	}

	isRunning(id: string): boolean {
		const tool = this.tools.find((t) => t.id === id)
		if (tool?.systemdUnit) {
			return this.runningSystemdUnits.has(tool.systemdUnit)
		}
		if (tool?.flatpakAppId) {
			return this.runningFlatpakApps.has(tool.flatpakAppId)
		}
		return this.processes.has(id) || this.externallyRunning.has(id)
	}

	async startProcess(id: string): Promise<void> {
		const tool = this.tools.find((t) => t.id === id)
		if (!tool) {
			this.log('warn', `Cannot start unknown tool "${id}"`)
			return
		}
		if (this.isRunning(id)) {
			this.log('info', `"${tool.label}" is already running, not starting another instance`)
			return
		}

		if (tool.systemdUnit) {
			this.log('info', `Starting "${tool.label}" via systemctl --user start ${tool.systemdUnit}`)
			try {
				// No --wait here: for a persistent service it doesn't return once the unit is up, it blocks
				// until the unit exits entirely - i.e. for the service's whole lifetime. This only rejects on
				// a dispatch failure (bad unit name, etc.); a unit that starts and then immediately fails
				// won't be caught here, but shows up within a few seconds via the is-active poll regardless.
				await execFileAsync('systemctl', ['--user', 'start', tool.systemdUnit])
				this.runningSystemdUnits.add(tool.systemdUnit)
			} catch (e) {
				this.log('error', `Failed to start "${tool.label}": ${e instanceof Error ? e.message : String(e)}`)
				this.runningSystemdUnits.delete(tool.systemdUnit)
			}
			this.checkFeedbacks('process_running')
			return
		}

		this.log('info', `Starting "${tool.label}": ${tool.path} ${tool.args.join(' ')}`.trimEnd())

		// Companion launches each module host with a stripped-down environment (no DISPLAY/WAYLAND_DISPLAY/
		// DBUS_SESSION_BUS_ADDRESS), so GUI tools spawned with a plain inherited env fail to find a display.
		// Pull the real values from the systemd user manager, which the desktop session imports them into at login.
		// Also resolve PATH via the user's own interactive shell rather than the module host's (or systemd
		// user session's) bare PATH: neither includes per-project PATH setup like nvm/rbenv/pyenv version
		// managers, which live in shell rc files - and a tool that itself shells out to something on PATH
		// (e.g. a dev server invoking `npx`) silently fails to find it otherwise.
		const [sessionEnv, shellPath] = await Promise.all([this.getDesktopSessionEnv(), this.getShellPath()])

		let child: ChildProcess
		try {
			// detached + unref: children outlive this module instance (e.g. across a Companion restart)
			// and shutting down Companion never has to wait on them. stderr is piped (not ignored) purely
			// for diagnostics: a bounded tail of it gets logged if the process exits with a non-zero code,
			// since that's otherwise the only way to see why e.g. a port conflict killed it on startup.
			//
			// Spawned via `sh -c 'unset ...; exec "$0" "$@"'` rather than invoking tool.path directly: Node's
			// permission model (active on this module host per the manifest's declared permissions) forcibly
			// re-injects NODE_OPTIONS (carrying --permission) into every child this process spawns, regardless
			// of the env object passed to spawn() - verified directly, not just inferred from docs. That's a
			// deliberate anti-sandbox-escape measure in Node itself, harmless for non-Node executables but
			// fatal for a Node-based tool, since Node refuses to start at all with --permission set via
			// NODE_OPTIONS. Routing through an interposed shell that unsets it right before exec sidesteps
			// this: the exec'd target keeps the same pid (exec replaces the process image, doesn't fork), so
			// this changes nothing about how the resulting process is tracked or killed afterward.
			child = spawn(
				'/bin/sh',
				[
					'-c',
					'unset NODE_OPTIONS NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE; exec "$0" "$@"',
					tool.path,
					...tool.args,
				],
				{
					cwd: tool.cwd,
					env: this.buildChildEnv(sessionEnv, shellPath),
					detached: true,
					stdio: ['ignore', 'ignore', 'pipe'],
				},
			)
			child.unref()
		} catch (e) {
			this.log('error', `Failed to start "${tool.label}": ${e instanceof Error ? e.message : String(e)}`)
			return
		}

		this.processes.set(id, child)
		this.externallyRunning.delete(id)
		this.checkFeedbacks('process_running')

		let stderrTail = ''
		child.stderr?.on('data', (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_MAX_LENGTH)
		})

		child.once('error', (err) => {
			this.log('error', `"${tool.label}" failed to start: ${err.message}`)
			this.processes.delete(id)
			this.checkFeedbacks('process_running')
		})

		child.once('exit', (code, signal) => {
			if (tool.flatpakAppId) {
				// flatpak run hands off to the sandboxed instance and exits well before the app does -
				// this is not necessarily the app stopping, just logged quieter than a real exit.
				this.log('debug', `"${tool.label}" flatpak run launcher exited (code ${code ?? 'null'}), handoff complete`)
			} else if (tool.processMatch) {
				// Same idea as Flatpak: this may just be a launcher handing off to the real process.
				this.log('debug', `"${tool.label}" launcher exited (code ${code ?? 'null'})`)
			} else {
				this.log('info', `"${tool.label}" exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
			}
			if (code !== null && code !== 0 && stderrTail.trim()) {
				this.log('warn', `"${tool.label}" stderr:\n${stderrTail.trim()}`)
			}
			this.processes.delete(id)
			// Always refresh: for flatpak/processMatch tools this may just reflect a normal handoff (the
			// poll will correct it within a few seconds either way), but if the process failed outright
			// rather than handing off, isRunning() is now accurately false and the feedback must catch up
			// immediately rather than staying stuck on whatever it showed when this process was launched.
			this.checkFeedbacks('process_running')
		})
	}

	async stopProcess(id: string): Promise<void> {
		const tool = this.tools.find((t) => t.id === id)

		if (tool?.systemdUnit) {
			this.log('info', `Stopping "${tool.label}" via systemctl --user stop ${tool.systemdUnit}`)
			try {
				// No --wait: plain `stop` already blocks until the unit is fully stopped by default, and
				// --wait is rejected outright as invalid alongside `stop` on some systemd versions anyway
				// (verified directly - it's only accepted alongside `start`/`restart`).
				await execFileAsync('systemctl', ['--user', 'stop', tool.systemdUnit])
			} catch (e) {
				this.log('warn', `Stopping "${tool.label}" reported an error: ${e instanceof Error ? e.message : String(e)}`)
			}
			this.runningSystemdUnits.delete(tool.systemdUnit)
			this.checkFeedbacks('process_running')
			return
		}

		if (tool?.flatpakAppId) {
			this.log('info', `Stopping "${tool.label}" via flatpak kill`)
			try {
				await execFileAsync('flatpak', ['kill', tool.flatpakAppId])
			} catch {
				this.log('info', `"${tool.label}" is not running`)
				return
			} finally {
				this.processes.get(id)?.kill()
			}
			this.runningFlatpakApps.delete(tool.flatpakAppId)
			this.checkFeedbacks('process_running')
			return
		}

		if (tool?.processMatch) {
			// The launched executable (e.g. a self-updating launcher) may have already exited after handing
			// off to the process that actually keeps running, so there's no ChildProcess handle to kill here -
			// find whatever is currently running by command line and signal it directly.
			this.processes.get(id)?.kill()

			const processes = await psList()
			const matches = processes.filter((p) => p.cmd?.includes(tool.processMatch!))
			if (matches.length === 0) {
				this.log('info', `"${tool.label}" is not running`)
				return
			}
			for (const match of matches) {
				this.log('info', `Stopping "${tool.label}" (pid ${match.pid})`)
				try {
					process.kill(match.pid, 'SIGTERM')
				} catch (e) {
					this.log(
						'warn',
						`Failed to stop "${tool.label}" pid ${match.pid}: ${e instanceof Error ? e.message : String(e)}`,
					)
				}
			}
			this.externallyRunning.delete(id)
			this.checkFeedbacks('process_running')
			return
		}

		const child = this.processes.get(id)
		if (!child) {
			if (this.externallyRunning.has(id)) {
				this.log('warn', `"${tool?.label ?? id}" is running but wasn't started by this module, cannot stop it`)
			} else {
				this.log('info', `"${tool?.label ?? id}" is not running`)
			}
			return
		}

		this.log('info', `Stopping "${tool?.label ?? id}"`)
		child.kill()
	}

	async toggleProcess(id: string): Promise<void> {
		// stopProcess already logs and no-ops for tools running externally with no handle to stop.
		if (this.isRunning(id)) {
			await this.stopProcess(id)
		} else {
			await this.startProcess(id)
		}
	}

	private buildChildEnv(sessionEnv: Record<string, string>, shellPath: string | undefined): NodeJS.ProcessEnv {
		// process.env here is the module host's own live environment, which includes Node/Companion-internal
		// plumbing that's only meaningful for the module host process itself: NODE_CHANNEL_* are IPC fork()
		// artifacts (inheriting them crashes a spawned Node child with SIGABRT, since there's no real pipe at
		// that fd), and NODE_OPTIONS carries the sandbox --permission flags Companion enables per the
		// manifest's declared permissions - Node hard-refuses to start at all if a child inherits --permission
		// via NODE_OPTIONS specifically (only allowed via direct CLI args). Strip these before forwarding.
		const env = { ...process.env, ...sessionEnv }
		delete env.NODE_OPTIONS
		delete env.NODE_CHANNEL_FD
		delete env.NODE_CHANNEL_SERIALIZATION_MODE
		if (shellPath) env.PATH = shellPath
		return env
	}

	private async getDesktopSessionEnv(): Promise<Record<string, string>> {
		try {
			const { stdout } = await execFileAsync('systemctl', ['--user', 'show-environment'])
			const env: Record<string, string> = {}
			for (const line of stdout.split('\n')) {
				const eq = line.indexOf('=')
				if (eq === -1) continue
				env[line.slice(0, eq)] = line.slice(eq + 1)
			}
			return env
		} catch (e) {
			this.log(
				'warn',
				`Could not read the systemd user session environment; GUI tools may fail to find a display: ${
					e instanceof Error ? e.message : String(e)
				}`,
			)
			return {}
		}
	}

	private async getShellPath(): Promise<string | undefined> {
		// Not process.env.SHELL: the module host's own environment doesn't reliably have it set, and falling
		// back to /bin/sh is actively wrong here - it's bash running in POSIX/sh-compatibility mode, which
		// does NOT source .bashrc/.zshrc for interactive shells, defeating the entire point of this. Reading
		// the login shell from the OS user database instead works regardless of what env this process has.
		const shell = os.userInfo().shell || '/bin/bash'
		try {
			// -i so rc files (nvm/rbenv/pyenv version-manager setup, etc.) actually get sourced, matching
			// what a real terminal would have. Take the last non-empty output line in case the interactive
			// shell prints other output (motd, etc.) before running the echo.
			const { stdout } = await execFileAsync(shell, ['-ic', 'echo "$PATH"'], { timeout: 5000 })
			const lines = stdout
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean)
			return lines.at(-1)
		} catch (e) {
			this.log(
				'warn',
				`Could not resolve PATH via ${shell}; tools that shell out to something on PATH themselves (npx, etc.) may fail to find it: ${
					e instanceof Error ? e.message : String(e)
				}`,
			)
			return undefined
		}
	}

	private applyToolConfig(): void {
		const { tools, errors } = ParseManagedTools(this.config.tools)
		this.tools = tools
		for (const err of errors) {
			this.log('warn', err)
		}

		const validIds = new Set(tools.map((t) => t.id))
		for (const id of [...this.externallyRunning]) {
			if (!validIds.has(id)) this.externallyRunning.delete(id)
		}

		const validAppIds = new Set(tools.map((t) => t.flatpakAppId).filter(Boolean))
		for (const appId of [...this.runningFlatpakApps]) {
			if (!validAppIds.has(appId)) this.runningFlatpakApps.delete(appId)
		}

		const validUnits = new Set(tools.map((t) => t.systemdUnit).filter(Boolean))
		for (const unit of [...this.runningSystemdUnits]) {
			if (!validUnits.has(unit)) this.runningSystemdUnits.delete(unit)
		}
	}

	private async pollExternalProcesses(): Promise<void> {
		const untracked = this.tools.filter((t) => !t.flatpakAppId && !this.processes.has(t.id))
		if (untracked.length === 0) return

		const processes = await psList()
		const runningNames = new Set(processes.map((p) => p.name))

		let changed = false
		for (const tool of untracked) {
			const running = tool.processMatch
				? processes.some((p) => p.cmd?.includes(tool.processMatch!))
				: runningNames.has(path.basename(tool.path))
			const was = this.externallyRunning.has(tool.id)
			if (running !== was) {
				changed = true
				if (running) this.externallyRunning.add(tool.id)
				else this.externallyRunning.delete(tool.id)
			}
		}

		if (changed) this.checkFeedbacks('process_running')
	}

	private async pollFlatpakApps(): Promise<void> {
		const appIds = new Set(this.tools.map((t) => t.flatpakAppId).filter((appId): appId is string => !!appId))
		if (appIds.size === 0) return

		const { stdout } = await execFileAsync('flatpak', ['ps', '--columns=application'])
		const running = new Set(
			stdout
				.split('\n')
				.map((line) => line.trim())
				.filter(Boolean),
		)

		let changed = false
		for (const appId of appIds) {
			const isRunning = running.has(appId)
			const was = this.runningFlatpakApps.has(appId)
			if (isRunning !== was) {
				changed = true
				if (isRunning) this.runningFlatpakApps.add(appId)
				else this.runningFlatpakApps.delete(appId)
			}
		}

		if (changed) this.checkFeedbacks('process_running')
	}

	private async pollSystemdUnits(): Promise<void> {
		const units = [...new Set(this.tools.map((t) => t.systemdUnit).filter((unit): unit is string => !!unit))]
		if (units.length === 0) return

		// is-active exits non-zero when not all queried units are active (behavior has varied across systemd
		// versions), but still prints one status line per unit either way - pull stdout from whichever path.
		let stdout: string
		try {
			stdout = (await execFileAsync('systemctl', ['--user', 'is-active', ...units])).stdout
		} catch (e) {
			stdout = (e as { stdout?: string }).stdout ?? ''
		}
		const states = stdout.split('\n').map((line) => line.trim())

		let changed = false
		units.forEach((unit, index) => {
			const isRunning = states[index] === 'active'
			const was = this.runningSystemdUnits.has(unit)
			if (isRunning !== was) {
				changed = true
				if (isRunning) this.runningSystemdUnits.add(unit)
				else this.runningSystemdUnits.delete(unit)
			}
		})

		if (changed) this.checkFeedbacks('process_running')
	}
}
