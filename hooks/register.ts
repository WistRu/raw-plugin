import type { Register } from 'claude-code'
import { registerResourceGuard } from './resource-guard/index'

// Raw Plugin: one hooks module composed of modules, one folder each.
export const register: Register = (on, options) => {
  registerResourceGuard(on, options)
}
