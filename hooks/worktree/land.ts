// The landing: the worktree the session works in goes onto the main branch
// with a fast-forward, then the worktree and its branch are deleted. Each
// step refuses with its reason and nothing after it runs; nothing is ever
// rebased, forced or merged any other way.

import type { Host, Ran, Repo } from './repo'
import { CONFIG_FILE, isMain, lines, ownerOf } from './repo'

// preLand can be a test run: ten minutes, the most a process may take.
const HOOK_TIMEOUT_MS = 10 * 60_000

const tail = (r: Ran, n = 15) => lines(`${r.out}\n${r.err}`).slice(-n).join('\n')

const argvOf = (command: string | string[]) => (typeof command === 'string' ? ['sh', '-c', command] : command)

async function runHook(host: Host, command: string | string[], cwd: string): Promise<Ran> {
  return host.run(argvOf(command), cwd, HOOK_TIMEOUT_MS).catch(err => ({ code: -1, out: '', err: String(err) }))
}

export type LandOptions = {
  // Takes the session out of the worktree before it is removed; false when
  // the session cannot leave it (a folder the app made for the session).
  leave: (path: string) => Promise<boolean>
}

// The report of the landing, or the refusal that stopped it.
export async function land(host: Host, repo: Repo, cwdReal: string, opts: LandOptions): Promise<string> {
  const refuse = (why: string) => `Not landed: ${why}`
  if (repo.configError) return refuse(`${repo.mainReal}/${CONFIG_FILE} does not parse (${repo.configError}); fix it first.`)
  const tree = ownerOf(repo, cwdReal)
  if (!tree || isMain(repo, tree)) return refuse(`this session runs in the main tree of ${repo.root}, not in a worktree; land from the session that works in the worktree (or EnterWorktree with its path first).`)
  if (tree.isDetached || !tree.branch) return refuse(`the worktree ${tree.path} is on a detached HEAD; a landing needs a branch.`)
  const branch = tree.branch
  const main = repo.main

  // 1. the worktree is clean
  const own = await host.run(['git', 'status', '--porcelain'], tree.path)
  if (own.code !== 0) return refuse(`git status failed in ${tree.path}: ${tail(own)}`)
  if (own.out.trim()) return refuse(`the worktree ${tree.path} has uncommitted changes; commit them (or drop them) first:\n${lines(own.out).slice(0, 10).join('\n')}`)

  // 2. the main tree has the main branch checked out and no change to a tracked file
  const head = await host.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], repo.mainReal)
  const checkedOut = head.code === 0 ? head.out.trim() : '(detached HEAD)'
  if (checkedOut !== main) return refuse(`the main tree ${repo.root} has ${checkedOut} checked out, not ${main}; check out ${main} there first.`)
  const theirs = await host.run(['git', 'status', '--porcelain', '--untracked-files=no'], repo.mainReal)
  if (theirs.code !== 0) return refuse(`git status failed in ${repo.root}: ${tail(theirs)}`)
  if (theirs.out.trim()) return refuse(`the main tree ${repo.root} has uncommitted changes to tracked files; they are someone's work, so nothing is merged over them:\n${lines(theirs.out).slice(0, 10).join('\n')}`)

  // 3. the branch contains the main branch
  const ancestor = await host.run(['git', 'merge-base', '--is-ancestor', main, 'HEAD'], tree.path)
  if (ancestor.code === 1) return refuse(`rebase first: ${branch} does not contain ${main}. In the worktree run \`git rebase ${main}\`, resolve what it asks, then land again.`)
  if (ancestor.code !== 0) return refuse(`git merge-base failed in ${tree.path}: ${tail(ancestor)}`)
  const log = await host.run(['git', 'log', '--format=%h %s', `${main}..HEAD`], tree.path)
  const commits = lines(log.out)
  if (commits.length === 0) return refuse(`${branch} has no commit that is not on ${main}; nothing to land (/worktree prune removes a landed branch and its worktree).`)

  // 4. preLand, in the worktree
  const notes: string[] = []
  if (repo.config.preLand) {
    const pre = await runHook(host, repo.config.preLand, tree.path)
    if (pre.code !== 0) return refuse(`preLand exited ${pre.code} in ${tree.path}; nothing was merged:\n${tail(pre)}`)
    notes.push('preLand passed.')
  }

  // 5. the fast-forward, in the main tree
  const before = (await host.run(['git', 'rev-parse', '--short', main], repo.mainReal)).out.trim()
  const merged = await host.run(['git', 'merge', '--ff-only', branch], repo.mainReal)
  if (merged.code !== 0) return refuse(`git merge --ff-only ${branch} failed in ${repo.root}; nothing was merged:\n${tail(merged)}`)
  const after = (await host.run(['git', 'rev-parse', '--short', main], repo.mainReal)).out.trim()

  // 6. postLand, in the main tree; the landing stands whatever it answers
  if (repo.config.postLand) {
    const post = await runHook(host, repo.config.postLand, repo.mainReal)
    notes.push(post.code === 0 ? 'postLand passed.' : `postLand exited ${post.code} in ${repo.root} (the landing stands):\n${tail(post)}`)
  }

  // 7. the worktree and the branch go, without --force
  if (!(await opts.leave(tree.path))) {
    notes.push(`The worktree ${tree.path} and the branch ${branch} are kept: this session runs in that folder and cannot leave it. /worktree prune removes them from another session once this one is done.`)
  } else {
    const removed = await host.run(['git', 'worktree', 'remove', tree.path], repo.mainReal)
    if (removed.code !== 0) notes.push(`git worktree remove ${tree.path} refused (the landing stands): ${tail(removed, 5)}`)
    else {
      const deleted = await host.run(['git', 'branch', '-d', branch], repo.mainReal)
      notes.push(deleted.code === 0 ? `Removed the worktree ${tree.path} and deleted the branch ${branch}.` : `Removed the worktree ${tree.path}; git branch -d ${branch} refused: ${tail(deleted, 5)}`)
    }
  }

  return [
    `Landed ${commits.length} commit${commits.length === 1 ? '' : 's'} of ${branch} on ${main} in ${repo.root} (${before}..${after}):`,
    ...commits.map(c => `- ${c}`),
    ...notes,
  ].join('\n')
}
