// Pruning: the branches whose every commit is already on the main branch,
// and the worktrees that hold them. "Landed" is content, not ancestry:
// `git cherry <main> <b>` lists no `+` commit, however the branch got there
// (a fast-forward or a rebase). Ported from BTC5Model's
// prune_landed_branches.sh with its refusals and without its project's own.
//
// Never touched: the main branch and the branch checked out in the main
// tree; a detached worktree (it has no branch to be landed); a worktree with
// any change or untracked file; the worktree this session runs in; a branch
// with no commit of its own yet (only its creation in the reflog: a
// worktree just entered, maybe by another session). Never `--force`.

import type { Host, Repo, Tree } from './repo'
import { isMain, lines, ownerOf } from './repo'

export type Landed = {
  branch: string
  tree?: Tree
  size?: string
  // -d when the branch is an ancestor of main (git checks it again);
  // -D when it was landed by rebase, with the cherry list as the proof.
  flag: '-d' | '-D'
  cherry: string[]
}

export type Scan = { landed: Landed[]; kept: string[] }

export async function scan(host: Host, repo: Repo, cwdReal: string, sizes = true): Promise<Scan> {
  const main = repo.main
  const out: Scan = { landed: [], kept: [] }
  const head = await host.run(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], repo.mainReal)
  const current = head.code === 0 ? head.out.trim() : undefined
  const here = ownerOf(repo, cwdReal)
  const refs = await host.run(['git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repo.mainReal)
  for (const b of lines(refs.out)) {
    if (b === main || b === current) continue
    const cherry = await host.run(['git', 'cherry', main, b], repo.mainReal)
    if (cherry.code !== 0) continue
    const list = lines(cherry.out)
    if (list.some(l => l.startsWith('+'))) continue
    const tree = repo.trees.find(t => t.branch === b)
    if (tree && isMain(repo, tree)) continue
    if (tree && here && tree.path === here.path) {
      out.kept.push(`${b}: landed, but this session runs in its worktree ${tree.path}`)
      continue
    }
    if (list.length === 0) {
      const reflog = await host.run(['git', 'reflog', 'show', '--format=%gs', `refs/heads/${b}`], repo.mainReal)
      if (lines(reflog.out).length <= 1) {
        out.kept.push(`${b}: no commit of its own yet${tree ? ` (worktree ${tree.path})` : ''}; maybe just entered, left alone`)
        continue
      }
    }
    let size: string | undefined
    if (tree) {
      const exists = await host.exists(tree.path)
      const status = exists ? await host.run(['git', 'status', '--porcelain'], tree.path) : undefined
      if (status && (status.code !== 0 || status.out.trim())) {
        out.kept.push(`${b}: landed, but its worktree ${tree.path} has ${status.code !== 0 ? 'a status git cannot read' : `${lines(status.out).length} changed or untracked path(s)`}; decide by hand`)
        continue
      }
      if (exists && sizes) size = (await host.run(['du', '-sh', tree.path], repo.mainReal, 60_000).catch(() => undefined))?.out.split('\t')[0]?.trim() || undefined
    }
    const ancestor = await host.run(['git', 'merge-base', '--is-ancestor', b, main], repo.mainReal)
    out.landed.push({ branch: b, tree, size, flag: ancestor.code === 0 ? '-d' : '-D', cherry: list })
  }
  return out
}

// The one line for the prompt section; undefined when nothing can go.
export function pruneLine(s: Scan): string | undefined {
  if (s.landed.length === 0) return undefined
  const each = s.landed.map(l => (l.tree ? `${l.branch} (worktree ${l.tree.path}${l.size ? `, ${l.size}` : ''})` : l.branch))
  return `Prune: ${s.landed.length} landed branch${s.landed.length === 1 ? '' : 'es'} can go: ${each.join(', ')}; /worktree prune (mcp__rp__worktree_prune) removes them.`
}

const proof = (l: Landed) => (l.flag === '-d' ? 'an ancestor of the main branch' : `not an ancestor; git cherry lists no unlanded commit: ${l.cherry.join(', ') || '(empty)'}`)

export async function prune(host: Host, repo: Repo, cwdReal: string): Promise<string> {
  // records of worktree folders already gone; touches no folder
  await host.run(['git', 'worktree', 'prune'], repo.mainReal)
  const s = await scan(host, repo, cwdReal)
  const done: string[] = []
  for (const l of s.landed) {
    if (l.tree && (await host.exists(l.tree.path))) {
      const removed = await host.run(['git', 'worktree', 'remove', l.tree.path], repo.mainReal)
      if (removed.code !== 0) {
        done.push(`kept ${l.branch}: git worktree remove ${l.tree.path} refused: ${lines(removed.err || removed.out).slice(-3).join(' ')}`)
        continue
      }
      done.push(`removed worktree ${l.tree.path}${l.size ? ` (${l.size})` : ''}`)
    }
    // the proof is printed beside the deletion it allows
    const deleted = await host.run(['git', 'branch', l.flag, l.branch], repo.mainReal)
    done.push(deleted.code === 0 ? `deleted branch ${l.branch} (${l.flag}: ${proof(l)})` : `FAILED to delete branch ${l.branch} (${l.flag}): ${lines(deleted.err).slice(-2).join(' ')}`)
  }
  const head = s.landed.length === 0 ? `Nothing to prune in ${repo.root}: no landed branch.` : `Pruned in ${repo.root} (main branch ${repo.main}):`
  return [head, ...done.map(d => `- ${d}`), ...(s.kept.length ? ['Kept:', ...s.kept.map(k => `- ${k}`)] : [])].join('\n')
}
