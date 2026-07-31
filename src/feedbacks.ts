import type { DropdownChoice } from '@companion-module/base'
import type ModuleInstance from './main.js'

export type FeedbacksSchema = {
	process_running: {
		type: 'boolean'
		options: {
			tool: string
		}
	}
}

function getToolChoices(self: ModuleInstance): DropdownChoice[] {
	return self.getManagedTools().map((tool) => ({ id: tool.id, label: tool.label }))
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const choices = getToolChoices(self)

	self.setFeedbackDefinitions({
		process_running: {
			name: 'Process Running',
			type: 'boolean',
			defaultStyle: {
				bgcolor: 0x00ff00,
				color: 0x000000,
			},
			options: [
				{
					id: 'tool',
					type: 'dropdown',
					label: 'Tool',
					choices,
					default: choices[0]?.id ?? '',
				},
			],
			callback: (feedback) => {
				return self.isRunning(feedback.options.tool)
			},
		},
	})
}
