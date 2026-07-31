import type ModuleInstance from './main.js'

export type VariablesSchema = Record<string, never>

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	self.setVariableDefinitions({})
}
