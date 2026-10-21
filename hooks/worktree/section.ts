// What the model reads of this module. The rule is the system prompt's:
// three lines that change only with the repository, so the prompt cache
// holds. Where the session stands and what can be pruned change with every
// commit, so they ride each prompt as context instead, after the cached
// prefix. Pure; the hooks compute the place.

import type { Place, Repo } from './repo'
import { CONFIG_FILE } from './repo'

export function ruleText(repo: Repo): string {
  return [
    'Worktree rule: every code change goes in its own git worktree and branch; tracked files of the main tree are not edited in place.',
    'Before the first edit call EnterWorktree (or start the session with the app\'s worktree checkbox), and commit in the worktree as you go.',
    `When the work is committed, land it with mcp__rp__land (/land): a fast-forward onto ${repo.main}, then the worktree and its branch are removed; a branch that does not contain ${repo.main} is rebased in its worktree first.`,
  ].join('\n')
}

export function placeText(repo: Repo, place: Place, isOn: boolean, pruneLine?: string): string {
  let here: string
  if (place.kind === 'main')
    here = isOn ? `Here: main tree of ${repo.root}: code edits are refused, enter a worktree first.` : `Here: main tree of ${repo.root}; the guard is off for this session (/worktree on restores it).`
  else
    here = `Here: worktree ${place.path}, branch ${place.branch ?? '(detached)'}, ${place.ahead} commit${place.ahead === 1 ? '' : 's'} not on ${repo.main}, ${place.isDirty ? 'dirty' : 'clean'}.`
  if (repo.configError) here += ` ${CONFIG_FILE} is not taken (${repo.configError}); /land refuses until it is fixed.`
  return [here, ...(pruneLine ? [pruneLine] : [])].join('\n')
}
