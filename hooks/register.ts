import type { Register } from 'claude-code'
import { registerResourceGuard, startResourceGuard } from './resource-guard/index'
import { registerSysmon, startSysmon } from './sysmon/index'

// Raw Plugin: one hooks module composed of modules, one folder each. Each
// module registers its own hooks and starts in the one session.start below.
export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startSysmon($)
    await startResourceGuard($, options)
    return started
  })
  registerSysmon(on)
  registerResourceGuard(on)
}
