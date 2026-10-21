import type { Register } from 'claude-code'
import { machineSection, registerResourceGuard, startResourceGuard } from './resource-guard/index'
import { registerSysmon, startSysmon } from './sysmon/index'
import { registerTeam, startTeam, teamSection } from './team/index'

// Raw Plugin: one hooks module composed of modules, one folder each. Each
// module registers its own hooks and starts in the one session.start below;
// the system prompt is one hook too, each module giving it one section.
export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startSysmon($)
    await startResourceGuard($, options)
    await startTeam($)
    return started
  })
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    const added = [machineSection($), await teamSection($)].filter(s => s !== undefined)
    return { sections: [...sections, ...added] }
  })
  registerSysmon(on)
  registerResourceGuard(on)
  registerTeam(on)
}
