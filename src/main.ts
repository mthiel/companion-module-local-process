import { InstanceBase, InstanceStatus, type SomeCompanionConfigField } from '@companion-module/base'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
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

		this.log('info', `Starting "${tool.label}": ${tool.path} ${tool.args.join(' ')}`.trimEnd())

		// Companion launches each module host with a stripped-down environment (no DISPLAY/WAYLAND_DISPLAY/
		// DBUS_SESSION_BUS_ADDRESS), so GUI tools spawned with a plain inherited env fail to find a display.
		// Pull the real values from the systemd user manager, which the desktop session imports them into at login.
		const sessionEnv = await this.getDesktopSessionEnv()

		let child: ChildProcess
		try {
			// detached + unref: children outlive this module instance (e.g. across a Companion restart)
			// and shutting down Companion never has to wait on them.
			child = spawn(tool.path, tool.args, {
				cwd: tool.cwd,
				env: { ...process.env, ...sessionEnv },
				detached: true,
				stdio: 'ignore',
			})
			child.unref()
		} catch (e) {
			this.log('error', `Failed to start "${tool.label}": ${e instanceof Error ? e.message : String(e)}`)
			return
		}

		this.processes.set(id, child)
		this.externallyRunning.delete(id)
		this.checkFeedbacks('process_running')

		child.once('error', (err) => {
			this.log('error', `"${tool.label}" failed to start: ${err.message}`)
			this.processes.delete(id)
			this.checkFeedbacks('process_running')
		})

		child.once('exit', (code, signal) => {
			if (tool.flatpakAppId) {
				// flatpak run hands off to the sandboxed instance and exits well before the app does -
				// this is not the app stopping, so leave process_running state to the flatpak ps poll.
				this.log('debug', `"${tool.label}" flatpak run launcher exited (code ${code ?? 'null'}), handoff complete`)
			} else if (tool.processMatch) {
				// Same idea as Flatpak: this may just be a launcher handing off to the real process.
				// Leave process_running state to the next external-process poll.
				this.log('debug', `"${tool.label}" launcher exited (code ${code ?? 'null'})`)
			} else {
				this.log('info', `"${tool.label}" exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`)
				this.checkFeedbacks('process_running')
			}
			this.processes.delete(id)
		})
	}

	async stopProcess(id: string): Promise<void> {
		const tool = this.tools.find((t) => t.id === id)

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
}
