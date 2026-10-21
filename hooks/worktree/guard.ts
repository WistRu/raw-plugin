// The guard: in the main tree, a write to tracked code is refused with the
// way out. Untracked and ignored paths are never refused, nor anything in a
// worktree or outside the repository.

import type { Host, Repo } from './repo'
import { isMain, ownerOf, trackedCode } from './repo'

export const WAY_OUT = 'enter a worktree first (the EnterWorktree tool, or the app\'s worktree checkbox for a new session), or lift the guard for this session with /worktree off'

// What a tool call writes, as the hook read it: real paths, and whether it
// rewrites the whole tree of the directory it runs in.
export type Writes = { verbs: string[]; reals: string[]; wholeTreeAt?: string }

// The reason a write is refused, or undefined when it may go ahead: no
// repository with a main branch, or the guard off for the session, refuses
// nothing.
export async function refusal(host: Host, repo: Repo | undefined, w: Writes, opts: { isOn: boolean; plugin: string }): Promise<string | undefined> {
  if (!repo || !opts.isOn) return undefined
  const plugin = opts.plugin
  if (w.wholeTreeAt !== undefined && isMain(repo, ownerOf(repo, w.wholeTreeAt)))
    return `${plugin}: ${w.verbs.join(', ')} rewrites the main tree of ${repo.root}, which holds the code; ${WAY_OUT}.`
  for (const real of w.reals) {
    if (!isMain(repo, ownerOf(repo, real))) continue
    const hit = await trackedCode(host, repo, real)
    if (hit.length === 0) continue
    const shown = hit.length === 1 && `${repo.mainReal}/${hit[0]}` === real ? hit[0] : `${hit[0]}${hit.length > 1 ? ` and ${hit.length - 1} more tracked file(s)` : ''}`
    return `${plugin}: ${shown} is tracked code in the main tree of ${repo.root}; code edits there are refused, ${WAY_OUT}.`
  }
  return undefined
}
