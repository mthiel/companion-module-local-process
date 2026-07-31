import type { SomeCompanionConfigField } from '@companion-module/base'

export interface ManagedTool {
	id: string
	label: string
	path: string
	args: string[]
	cwd: string | undefined
	/**
	 * Set this when `path` launches the tool via `flatpak run`. Flatpak's own run command exits as soon as
	 * it hands off to the sandboxed instance, well before the app itself exits, so tracking it as a plain
	 * child process gives false "stopped" state and `.kill()` targets the wrong process. When set, stop and
	 * running-state checks use `flatpak kill`/`flatpak ps` against this app id instead of the process handle.
	 */
	flatpakAppId: string | undefined
	/**
	 * Substring to match against a running process's full command line, for tools whose launched executable
	 * exits immediately after handing off to some other process it starts (e.g. self-updating launchers).
	 * There's no clean id-based API for this case (unlike Flatpak's), so when set, running-state detection
	 * falls back to scanning all processes for this substring, and stopping sends a signal directly to any
	 * matching pid instead of relying on a ChildProcess handle.
	 */
	processMatch: string | undefined
}

export type ModuleConfig = {
	tools: string
}

const SAMPLE_TOOLS = [
	{
		id: 'edmc',
		label: 'EDMC',
		flatpakAppId: 'io.edcd.EDMarketConnector',
		path: '/usr/bin/flatpak',
		args: ['run', '--command=edmarketconnector', 'io.edcd.EDMarketConnector'],
		cwd: '',
	},
]

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'tools-info',
			label: 'Managed Tools',
			width: 12,
			value:
				'Define the tools this module can start/stop, as a JSON array. Each entry needs: ' +
				'<code>id</code> (unique, used internally), <code>label</code> (shown in dropdowns), ' +
				'<code>path</code> (executable to run). Optional: <code>args</code> (array of strings), ' +
				'<code>cwd</code> (working directory), and <code>flatpakAppId</code> (set this when ' +
				'<code>path</code> launches via <code>flatpak run</code> — stop and running-state checks ' +
				'will use <code>flatpak kill</code>/<code>flatpak ps</code> instead of process tracking, since ' +
				'Flatpak run exits right after launch handoff), and <code>processMatch</code> (a substring to ' +
				"match against a running process's full command line, for launchers that exit immediately " +
				'after starting some other process, e.g. self-updating apps). Example:<br/><pre>' +
				JSON.stringify(SAMPLE_TOOLS, null, 2) +
				'</pre>',
		},
		{
			type: 'textinput',
			id: 'tools',
			label: 'Managed Tools (JSON)',
			width: 12,
			default: JSON.stringify(SAMPLE_TOOLS, null, 2),
			multiline: true,
		},
	]
}

/**
 * Parses and validates the `tools` config field.
 * Invalid entries are dropped (not thrown) so one bad entry doesn't take down the whole config;
 * problems are returned as human-readable messages for the caller to log.
 */
export function ParseManagedTools(raw: string | undefined): { tools: ManagedTool[]; errors: string[] } {
	const errors: string[] = []
	if (!raw || !raw.trim()) return { tools: [], errors }

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (e) {
		errors.push(`Managed Tools is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
		return { tools: [], errors }
	}

	if (!Array.isArray(parsed)) {
		errors.push('Managed Tools JSON must be an array')
		return { tools: [], errors }
	}

	const tools: ManagedTool[] = []
	const seenIds = new Set<string>()

	parsed.forEach((entry, index) => {
		if (typeof entry !== 'object' || entry === null) {
			errors.push(`Tool #${index + 1} is not an object, skipping`)
			return
		}
		const { id, label, path, args, cwd, flatpakAppId, processMatch } = entry as Record<string, unknown>

		if (typeof id !== 'string' || !id.trim()) {
			errors.push(`Tool #${index + 1} is missing a valid "id", skipping`)
			return
		}
		if (seenIds.has(id)) {
			errors.push(`Tool #${index + 1} has duplicate id "${id}", skipping`)
			return
		}
		if (typeof label !== 'string' || !label.trim()) {
			errors.push(`Tool "${id}" is missing a valid "label", skipping`)
			return
		}
		if (typeof path !== 'string' || !path.trim()) {
			errors.push(`Tool "${id}" is missing a valid "path", skipping`)
			return
		}
		if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))) {
			errors.push(`Tool "${id}" has an invalid "args" (must be an array of strings), skipping`)
			return
		}
		if (cwd !== undefined && typeof cwd !== 'string') {
			errors.push(`Tool "${id}" has an invalid "cwd" (must be a string), skipping`)
			return
		}
		if (flatpakAppId !== undefined && (typeof flatpakAppId !== 'string' || !flatpakAppId.trim())) {
			errors.push(`Tool "${id}" has an invalid "flatpakAppId" (must be a non-empty string), skipping`)
			return
		}
		if (processMatch !== undefined && (typeof processMatch !== 'string' || !processMatch.trim())) {
			errors.push(`Tool "${id}" has an invalid "processMatch" (must be a non-empty string), skipping`)
			return
		}

		seenIds.add(id)
		tools.push({
			id,
			label,
			path,
			args: args ?? [],
			cwd: cwd && cwd.trim() ? cwd : undefined,
			flatpakAppId: flatpakAppId || undefined,
			processMatch: processMatch || undefined,
		})
	})

	return { tools, errors }
}
