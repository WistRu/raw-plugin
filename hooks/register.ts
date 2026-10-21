import type { Register } from 'claude-code'
import { machineSection, registerResourceGuard, startResourceGuard } from './resource-guard/index'
import { registerSysmon, startSysmon } from './sysmon/index'
import { registerTeam, startTeam, teamSection } from './team/index'
import { registerWorktree, startWorktree, worktreeSection } from './worktree/index'

// Raw Plugin: one hooks module composed of modules, one folder each. Each
// module registers its own hooks and starts in the one session.start below;
// the system prompt is one hook too, each module giving it one section.
export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await startSysmon($)
    await startResourceGuard($, options)
    await startTeam($)
    await startWorktree($)
    return started
  })
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    const added = [machineSection($), await teamSection($), await worktreeSection($)].filter(s => s !== undefined)
    return { sections: [...sections, ...added] }
  })
  // first: a write the worktree guard refuses is never held for headroom
  registerWorktree(on)
  registerSysmon(on)
  registerResourceGuard(on)
  registerTeam(on)
}
