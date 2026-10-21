// worktree: every code change goes in its own git worktree and branch, is
// landed on the main branch with a fast-forward, then the worktree and the
// branch are deleted. Universal: any git repository, no configuration; the
// engine makes the worktrees (EnterWorktree, the desktop app, agents with
// `isolation: worktree`), this module adds the rule, its guard and the
// landing.
//
// The idea is BTC5Model's text rule and its prune_landed_branches.sh, with
// nothing of that project built in.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptComposeSection } from 'claude-code'

import { writeTargets } from '../team/bashzone'
import type { Writes } from './guard'
import { refusal } from './guard'
import { land } from './land'
import { prune, pruneLine, scan } from './prune'
import type { Host, Repo } from './repo'
import { placeOf, readRepo } from './repo'
import { placeText, ruleText } from './section'

export const isGuardOn = atom({ plugin: 'rp', key: 'isWorktreeGuardOn' } as const, true)

// A repository read is a handful of git calls; it is kept this long, and
// dropped whenever a worktree may have come or gone.
const REPO_FRESH_MS = 10_000
let cached: { root: string; at: number; repo: Repo | undefined } | undefined
let failedOnce = false
// The rule's text for the system prompt, undefined when silent. It changes
// only with the repository (its main branch), so the prompt cache holds.
let rule: string | undefined
// What can be pruned, read once at the session's start (and after a prune).
let pruneText: string | undefined

export function hostOf($: EngineInterface): Host {
  return {
    run: async (argv, cwd, timeoutMs) => {
      const r = await $.process.run(argv, { cwd, timeoutMs: timeoutMs ?? 30_000 })
      return { code: r.exitCode, out: r.stdout, err: r.stderr }
    },
    real: async path => {
      // the nearest ancestor that exists, resolved, and the rest appended
      let head = path.replace(/\/+$/, '') || '/'
      const rest: string[] = []
      for (;;) {
        const got = await $.fs.stat(head, { resolve: true }).catch(() => undefined)
        if (got?.realPath) return [got.realPath.replace(/\/$/, ''), ...rest].join('/') || '/'
        const cut = head.lastIndexOf('/')
        if (cut <= 0) return undefined
        rest.unshift(head.slice(cut + 1))
        head = head.slice(0, cut)
      }
    },
    read: path => $.fs.read(path).then(t => t, () => undefined),
    exists: path => $.fs.exists(path).catch(() => false),
  }
}

export function forget(): void {
  cached = undefined
}

// The session's repository as this module sees it; undefined when silent.
export async function repoOf($: EngineInterface): Promise<Repo | undefined> {
  const r = await $.session.repo().catch(() => null)
  if (!r) return undefined
  const now = await $.clock.now()
  if (cached && cached.root === r.root && now - cached.at < REPO_FRESH_MS) return cached.repo
  const repo = await readRepo(hostOf($), r.root)
  cached = { root: r.root, at: now, repo }
  return repo
}

async function absolute($: EngineInterface, path: string, cwd: string): Promise<string> {
  if (path === '~' || path.startsWith('~/')) return `${(await $.env.get('HOME')) ?? ''}${path.slice(1)}`
  return path.startsWith('/') ? path : `${cwd}/${path}`
}

async function guardWrites($: EngineInterface, w: (host: Host, cwd: string) => Promise<Writes | undefined>): Promise<string | undefined> {
  const isOn = await read($, isGuardOn)
  if (!isOn) return undefined
  const repo = await repoOf($)
  if (!repo) return undefined
  const host = hostOf($)
  const writes = await w(host, await $.session.cwd())
  return writes ? refusal(host, repo, writes, { isOn, plugin: $.plugin.name }) : undefined
}

async function fileWrites($: EngineInterface, host: Host, cwd: string, path: unknown): Promise<Writes | undefined> {
  if (typeof path !== 'string' || !path) return undefined
  const real = await host.real(await absolute($, path, cwd))
  return real ? { verbs: ['edit'], reals: [real] } : undefined
}

async function bashWrites($: EngineInterface, host: Host, cwd: string, command: string): Promise<Writes | undefined> {
  const t = writeTargets(command)
  if (!t) return undefined
  const reals: string[] = []
  for (const p of t.paths) {
    const real = await host.real(await absolute($, p, cwd))
    if (real) reals.push(real)
  }
  return { verbs: t.verbs, reals, wholeTreeAt: t.isWholeTree ? await host.real(cwd) : undefined }
}

// A guard that cannot read the repository lets the write through and says
// so once: a broken git must not stop every edit on the machine.
function failOpen($: EngineInterface, err: unknown): void {
  $.ui.log(`${$.plugin.name}: the worktree guard could not read the repository, so it let a write through: ${String(err)}`, { to: failedOnce ? 'debug' : 'transcript' })
  failedOnce = true
}

const answer = (text: string) => ({ result: text, text })

// The landing of the worktree this loop runs in. The session leaves the
// worktree first through the engine's own ExitWorktree (keep), so its folder
// is never pulled from under it; a subagent's call never moves the session.
async function landHere($: EngineInterface, agentId?: string): Promise<string> {
  const repo = await repoOf($)
  if (!repo) return 'Not landed: not in a git repository with a main branch (origin/HEAD, main or master).'
  const host = hostOf($)
  const cwd = await $.session.cwd()
  const cwdReal = (await host.real(cwd)) ?? cwd
  const leave = async (path: string) => {
    if (!(cwdReal === path || cwdReal.startsWith(`${path}/`))) return true
    if (agentId !== undefined) return false
    const ran = await $.tool.call({ tool: 'ExitWorktree', action: 'keep' }).catch(() => undefined)
    if (!ran || ('deny' in ran && ran.deny) || ran.isError) return false
    // `$.session.cwd()` stays what it was when this hook began, so the
    // tool's own answer says where the session went (seen live 2026-10-21)
    const out = ran.result as { restoredCwd?: string; originalCwd?: string } | undefined
    const went = out?.restoredCwd ?? out?.originalCwd
    if (went === undefined) return false
    const now = (await host.real(went)) ?? went
    return !(now === path || now.startsWith(`${path}/`))
  }
  try {
    return await land(host, repo, cwdReal, { leave })
  } finally {
    forget()
  }
}

async function scanPrune($: EngineInterface): Promise<void> {
  const repo = await repoOf($)
  if (!repo) return
  const host = hostOf($)
  const cwd = await $.session.cwd()
  pruneText = pruneLine(await scan(host, repo, (await host.real(cwd)) ?? cwd))
}

async function pruneHere($: EngineInterface): Promise<string> {
  const repo = await repoOf($)
  if (!repo) return 'Nothing to prune: not in a git repository with a main branch (origin/HEAD, main or master).'
  const host = hostOf($)
  const cwd = await $.session.cwd()
  try {
    return await prune(host, repo, (await host.real(cwd)) ?? cwd)
  } finally {
    forget()
    pruneText = undefined
  }
}

async function worktreeCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const word = (args ?? '').trim().split(/\s+/)[0] ?? ''
  if (word === 'prune') return { text: await pruneHere($).catch(err => `prune: ${String(err)}`) }
  if (word === 'off' || word === 'on') {
    await update($, isGuardOn, () => word === 'on')
    return { text: word === 'on' ? 'Worktree guard on for this session: code edits in the main tree are refused.' : 'Worktree guard off for this session: edits in the main tree go through. /worktree on restores it.' }
  }
  const repo = await repoOf($)
  const on = await read($, isGuardOn)
  if (!repo) return { text: 'Not in a git repository with a main branch (origin/HEAD, main or master): the worktree module is silent here.' }
  return { text: `Worktree guard ${on ? 'on' : 'off'} in ${repo.root} (main branch ${repo.main}). Usage: /worktree on | off | prune` }
}

// Where the session stands now, read afresh: the context a prompt carries.
// Also refreshes the rule, so the system prompt follows the repository.
async function placeNote($: EngineInterface): Promise<string | undefined> {
  forget()
  const repo = await repoOf($)
  rule = repo ? ruleText(repo) : undefined
  if (!repo) return undefined
  const host = hostOf($)
  const cwd = await $.session.cwd()
  const place = await placeOf(host, repo, (await host.real(cwd)) ?? cwd)
  return placeText(repo, place, await read($, isGuardOn), pruneText)
}

// The rule alone; hooks/register.ts adds it in the plugin's one
// prompt.compose hook.
export async function worktreeSection($: EngineInterface): Promise<PromptComposeSection | undefined> {
  return rule === undefined ? undefined : { id: `${$.plugin.name}:worktree`, text: rule, scope: 'session' }
}

// Called from the plugin's one session.start hook (hooks/register.ts).
export async function startWorktree($: EngineInterface): Promise<void> {
  cached = undefined
  failedOnce = false
  rule = undefined
  pruneText = undefined
  await scanPrune($).catch(err => $.ui.log(`${$.plugin.name}: the landed branches could not be listed: ${String(err)}`, { to: 'debug' }))
  await placeNote($).catch(err => $.ui.log(`${$.plugin.name}: the worktree rule could not be read: ${String(err)}`, { to: 'debug' }))
  await $.command.register({ name: 'worktree', description: 'The worktree guard: "off" lifts it for this session, "on" restores it; "prune" removes landed branches and their worktrees', argumentHint: 'on | off | prune' })
    .catch(err => $.ui.log(`${$.plugin.name}: /worktree not registered: ${String(err)}`, { to: 'debug' }))
  await $.command.register({ name: 'land', description: 'Land this worktree: fast-forward it onto the main branch, then remove the worktree and its branch' })
    .catch(err => $.ui.log(`${$.plugin.name}: /land not registered: ${String(err)}`, { to: 'debug' }))
  await $.tool.register({
    name: 'land',
    description: 'Land the worktree this session works in: refuses unless the worktree is clean, the main tree has the main branch checked out and is clean, and the branch contains the main branch (rebase first otherwise); runs preLand, merges with --ff-only, runs postLand, removes the worktree and deletes the branch, and reports the landed commits.',
    inputSchema: { type: 'object', properties: {} },
  })
  await $.tool.register({
    name: 'worktree_prune',
    description: 'Remove the landed branches (git cherry against the main branch lists no unlanded commit) and their clean worktrees, without --force; never the branch checked out in the main tree, a detached worktree, a dirty one, this session\'s own, or a branch with no commit of its own yet.',
    inputSchema: { type: 'object', properties: {} },
  })
}

export function registerWorktree(on: On): void {
  on('command.run', { command: 'worktree' }, ($, e) => worktreeCommand($, e.args))
  on('command.run', { command: 'rp:worktree' }, ($, e) => worktreeCommand($, e.args))
  on('command.run', { command: 'land' }, async $ => ({ text: await landHere($).catch(err => `Not landed: ${String(err)}`) }))
  on('command.run', { command: 'rp:land' }, async $ => ({ text: await landHere($).catch(err => `Not landed: ${String(err)}`) }))
  on('tool.call', { tool: 'mcp__rp__worktree_prune' }, async $ => answer(await pruneHere($).catch(err => `prune: ${String(err)}`)))
  on('tool.call', { tool: 'mcp__rp__land' }, async ($, e) => answer(await landHere($, e.agentId).catch(err => `Not landed: ${String(err)}`)))

  // MultiEdit is matched by name: this build ships no such tool, an older one may
  on('tool.call', { tool: /^(Edit|Write|MultiEdit)$/ }, async ($, e, next) => {
    const why = await guardWrites($, (host, cwd) => fileWrites($, host, cwd, (e as unknown as { file_path?: unknown }).file_path)).catch(err => (failOpen($, err), undefined))
    return why ? { deny: why } : next(e)
  })
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const why = await guardWrites($, (host, cwd) => fileWrites($, host, cwd, (e as unknown as { notebook_path?: unknown }).notebook_path)).catch(err => (failOpen($, err), undefined))
    return why ? { deny: why } : next(e)
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // most commands write nothing this reading sees: no git call for them
    if (!writeTargets(e.command)) return next(e)
    const why = await guardWrites($, (host, cwd) => bashWrites($, host, cwd, e.command)).catch(err => (failOpen($, err), undefined))
    return why ? { deny: why } : next(e)
  })

  // A worktree came or went: read the repository afresh.
  // Each prompt carries where the session stands, after the cached prefix.
  // The classic UserPromptSubmit event, not prompt.submit: the plugin's one
  // hooks module may hold one unmatched prompt.submit hook, and team's is it.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const done = await next(e)
    const note = await placeNote($).catch(err => {
      $.ui.log(`${$.plugin.name}: the worktree place could not be read: ${String(err)}`, { to: 'debug' })
      return undefined
    })
    return note === undefined ? done : { ...done, additionalContext: [...(done.additionalContext ?? []), note] }
  })

  on('tool.call', { tool: /^(EnterWorktree|ExitWorktree)$/ }, async ($, e, next) => {
    const done = await next(e)
    forget()
    return done
  })
}
