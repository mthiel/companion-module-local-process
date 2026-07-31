import type { DropdownChoice } from '@companion-module/base'
import type ModuleInstance from './main.js'

export type ActionsSchema = {
	start_process: {
		options: {
			tool: string
		}
	}
	stop_process: {
		options: {
			tool: string
		}
	}
	toggle_process: {
		options: {
			tool: string
		}
	}
}

function getToolChoices(self: ModuleInstance): DropdownChoice[] {
	return self.getManagedTools().map((tool) => ({ id: tool.id, label: tool.label }))
}

export function UpdateActions(self: ModuleInstance): void {
	const choices = getToolChoices(self)
	const toolOption = {
		id: 'tool' as const,
		type: 'dropdown' as const,
		label: 'Tool',
		choices,
		default: choices[0]?.id ?? '',
	}

	self.setActionDefinitions({
		start_process: {
			name: 'Start Process',
			options: [toolOption],
			callback: async (event) => {
				await self.startProcess(event.options.tool)
			},
		},
		stop_process: {
			name: 'Stop Process',
			options: [toolOption],
			callback: async (event) => {
				await self.stopProcess(event.options.tool)
			},
		},
		toggle_process: {
			name: 'Toggle Process',
			options: [toolOption],
			callback: async (event) => {
				await self.toggleProcess(event.options.tool)
			},
		},
	})
}
