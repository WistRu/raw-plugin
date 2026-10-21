import { expect, test } from 'claude-code/testing'

import { writeTargets } from '../team/bashzone'
import { refusal } from './guard'
import { land } from './land'
import { prune, pruneLine, scan } from './prune'
import type { Writes } from './guard'
import type { Host, Ran } from './repo'
import { parseConfig, placeOf, readRepo } from './repo'
import { placeText, ruleText } from './section'

// A repository made of answers: the git calls this module makes, answered
// from a few facts; `answers` overrides one call by `<cwd>: <argv>`.
type World = {
  // a spelled prefix and the real one it leads to (a symlink)
  links?: Record<string, string>
  originHead?: string
  branches: string[]
  // as `git worktree list` prints them, the main tree first
  trees: { path: string; branch?: string; isDetached?: boolean }[]
  // tracked files, relative to the main tree
  tracked: string[]
  files?: Record<string, string>
  // worktree folders git still lists that are gone from the disk
  gone?: string[]
  answers?: Record<string, Ran | ((n: number) => Ran)>
}

const ran = (out = '', code = 0, err = ''): Ran => ({ code, out, err })

function fake(w: World): Host & { calls: string[] } {
  const calls: string[] = []
  const seen = new Map<string, number>()
  const real = (p: string) => {
    for (const [from, to] of Object.entries(w.links ?? {})) if (p === from || p.startsWith(`${from}/`)) return to + p.slice(from.length)
    return p
  }
  const mainReal = real(w.trees[0]?.path ?? '/')
  return {
    calls,
    real: async p => real(p),
    read: async p => w.files?.[p],
    exists: async p => !(w.gone ?? []).includes(p),
    run: async (argv, cwd) => {
      const key = `${cwd}: ${argv.join(' ')}`
      calls.push(key)
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      const scripted = w.answers?.[key]
      if (scripted) return typeof scripted === 'function' ? scripted(n) : scripted
      const [, verb, ...rest] = argv
      if (verb === 'rev-parse' && rest[0] === '--verify') return w.branches.includes(String(rest[2]).replace('refs/heads/', '')) ? ran('abc') : ran('', 1)
      if (verb === 'symbolic-ref' && rest.includes('refs/remotes/origin/HEAD')) return w.originHead ? ran(`origin/${w.originHead}\n`) : ran('', 1)
      if (verb === 'worktree' && rest[0] === 'list')
        return ran(w.trees.map(t => `worktree ${t.path}\nHEAD 0123\n${t.isDetached ? 'detached' : `branch refs/heads/${t.branch}`}\n`).join('\n'))
      if (verb === 'ls-files') {
        const at = String(rest.at(-1))
        return ran(w.tracked.filter(f => `${mainReal}/${f}` === at || `${mainReal}/${f}`.startsWith(at === mainReal ? `${at}/` : `${at}/`)).map(f => `${f}\0`).join(''))
      }
      return ran('', 1, `unexpected: ${key}`)
    },
  }
}

const REPO: World = {
  branches: ['main', 'feat'],
  trees: [
    { path: '/r', branch: 'main' },
    { path: '/r/.claude/worktrees/feat', branch: 'feat' },
    { path: '/elsewhere/side', branch: 'side' },
  ],
  tracked: ['src/a.ts', 'docs/readme.md', 'Makefile'],
}

const ON = { isOn: true, plugin: 'rp' }
const edit = (real: string): Writes => ({ verbs: ['edit'], reals: [real] })

test('the guard refuses tracked code in the main tree and nothing else', async () => {
  const host = fake(REPO)
  const repo = await readRepo(host, '/r')
  expect(repo?.main).toBe('main')
  // tracked, main tree: refused, naming the way out
  const why = await refusal(host, repo, edit('/r/src/a.ts'), ON)
  expect(why).toMatch(/src\/a\.ts is tracked code in the main tree of \/r/)
  expect(why).toMatch(/EnterWorktree/)
  expect(why).toMatch(/\/worktree off/)
  // untracked and ignored paths: never refused
  expect(await refusal(host, repo, edit('/r/src/new.ts'), ON)).toBeUndefined()
  expect(await refusal(host, repo, edit('/r/target/debug/out.o'), ON)).toBeUndefined()
  // the same file in a worktree nested inside the main tree, and in one outside it
  expect(await refusal(host, repo, edit('/r/.claude/worktrees/feat/src/a.ts'), ON)).toBeUndefined()
  expect(await refusal(host, repo, edit('/elsewhere/side/src/a.ts'), ON)).toBeUndefined()
  // outside the repository
  expect(await refusal(host, repo, edit('/home/u/notes.md'), ON)).toBeUndefined()
  // off for the session: nothing refused
  expect(await refusal(host, repo, edit('/r/src/a.ts'), { ...ON, isOn: false })).toBeUndefined()
  // a directory holding tracked files is code too
  expect(await refusal(host, repo, { verbs: ['rm'], reals: ['/r/src'] }, ON)).toMatch(/src\/a\.ts is tracked code/)
})

test('a Bash write is read by bashzone and judged the same way', async () => {
  const host = fake(REPO)
  const repo = await readRepo(host, '/r')
  const bash = (command: string, cwd: string): Writes => {
    const t = writeTargets(command)
    if (!t) return { verbs: [], reals: [] }
    return { verbs: t.verbs, reals: t.paths.map(p => (p.startsWith('/') ? p : `${cwd}/${p}`)), wholeTreeAt: t.isWholeTree ? cwd : undefined }
  }
  expect(await refusal(host, repo, bash("sed -i 's/a/b/' src/a.ts", '/r'), ON)).toMatch(/src\/a\.ts is tracked code/)
  expect(await refusal(host, repo, bash('echo x > notes.txt', '/r'), ON)).toBeUndefined()
  // a verb that rewrites the whole tree: refused in the main tree, free in a worktree
  expect(await refusal(host, repo, bash('git commit -m wip', '/r'), ON)).toMatch(/git commit rewrites the main tree of \/r/)
  // a flag cluster: -a commits every tracked change, the message is no path
  expect(writeTargets('git commit -am "say hello"')).toEqual({ verbs: ['git commit'], paths: [], isWholeTree: true })
  expect(await refusal(host, repo, bash('git commit -am "say hello"', '/r'), ON)).toMatch(/git commit rewrites the main tree/)
  expect(await refusal(host, repo, bash('git commit -m wip', '/r/.claude/worktrees/feat'), ON)).toBeUndefined()
  expect(await refusal(host, repo, bash("sed -i 's/a/b/' src/a.ts", '/r/.claude/worktrees/feat'), ON)).toBeUndefined()
})

test('a root reached through a symlink is the same tree as its target', async () => {
  const world: World = {
    ...REPO,
    links: { '/home/u/link': '/data/repo' },
    trees: [{ path: '/data/repo', branch: 'main' }, { path: '/home/u/link-wt', branch: 'feat' }],
  }
  const host = fake(world)
  // the engine names the root by the symlink; git lists the real path
  const repo = await readRepo(host, '/home/u/link')
  expect(repo?.mainReal).toBe('/data/repo')
  // the hook makes every path real before asking: the symlinked spelling is the main tree
  const real = await host.real('/home/u/link/src/a.ts')
  expect(await refusal(host, repo, edit(real ?? ''), ON)).toMatch(/src\/a\.ts is tracked code in the main tree of \/home\/u\/link/)
  // a worktree whose name only starts like the root's is not under it
  expect(await refusal(host, repo, edit('/home/u/link-wt/src/a.ts'), ON)).toBeUndefined()
})

test('code prefixes: only the paths under them are code', async () => {
  const world: World = { ...REPO, files: { '/r/.claude/rp-worktree.json': JSON.stringify({ code: ['./src/'] }) } }
  const host = fake(world)
  const repo = await readRepo(host, '/r')
  expect(repo?.config.code).toEqual(['src'])
  expect(await refusal(host, repo, edit('/r/src/a.ts'), ON)).toMatch(/src\/a\.ts is tracked code/)
  expect(await refusal(host, repo, edit('/r/docs/readme.md'), ON)).toBeUndefined()
  expect(await refusal(host, repo, edit('/r/Makefile'), ON)).toBeUndefined()
})

test('no main branch: the module is silent; the main branch follows origin/HEAD', async () => {
  expect(await readRepo(fake({ ...REPO, branches: ['dev'] }), '/r')).toBeUndefined()
  expect((await readRepo(fake({ ...REPO, branches: ['master'] }), '/r'))?.main).toBe('master')
  expect((await readRepo(fake({ ...REPO, branches: ['main', 'trunk'], originHead: 'trunk' }), '/r'))?.main).toBe('trunk')
  // origin/HEAD naming a branch with no local copy falls back
  expect((await readRepo(fake({ ...REPO, branches: ['main'], originHead: 'trunk' }), '/r'))?.main).toBe('main')
})

test('the config file: three keys, anything else is refused by name', async () => {
  expect(parseConfig('{"preLand": "make test", "postLand": ["sh", "x.sh"]}')).toEqual({ config: { preLand: 'make test', postLand: ['sh', 'x.sh'] } })
  expect(parseConfig('{"gate": true}')).toEqual({ error: 'unknown key(s): gate; only code, preLand and postLand are read' })
  expect('error' in parseConfig('{')).toBe(true)
  expect(parseConfig('{"code": "src"}')).toEqual({ error: 'code must be a list of path prefixes' })
  const repo = await readRepo(fake({ ...REPO, files: { '/r/.claude/rp-worktree.json': '[]' } }), '/r')
  expect(repo?.configError).toBe('not a JSON object')
  expect(repo?.config).toEqual({})
})

test('the rule stays in the system prompt; the place rides each prompt', async () => {
  const host = fake({
    ...REPO,
    answers: {
      '/r/.claude/worktrees/feat: git rev-list --count main..HEAD': ran('2\n'),
      '/r/.claude/worktrees/feat: git status --porcelain': ran(' M src/a.ts\n'),
    },
  })
  const repo = await readRepo(host, '/r')
  if (!repo) throw new Error('no repo')
  const rule = ruleText(repo)
  expect(rule.split('\n').length).toBe(3)
  expect(rule).toMatch(/EnterWorktree/)
  expect(rule).toMatch(/mcp__rp__land/)
  // nothing in the rule depends on where the session stands: the cache holds
  expect(rule).not.toMatch(/Here:|Prune:|commits? not on|dirty|clean/)
  expect(placeText(repo, await placeOf(host, repo, '/r/src'), true)).toBe('Here: main tree of /r: code edits are refused, enter a worktree first.')
  expect(placeText(repo, await placeOf(host, repo, '/r'), false)).toMatch(/guard is off for this session \(\/worktree on restores it\)/)
  const inTree = placeText(repo, await placeOf(host, repo, '/r/.claude/worktrees/feat/src'), true, 'Prune: something')
  expect(inTree.split('\n')).toEqual(['Here: worktree /r/.claude/worktrees/feat, branch feat, 2 commits not on main, dirty.', 'Prune: something'])
})

const WT = '/r/.claude/worktrees/feat'
const happy = (): Record<string, Ran | ((n: number) => Ran)> => ({
  [`${WT}: git status --porcelain`]: ran(''),
  '/r: git symbolic-ref --quiet --short HEAD': ran('main\n'),
  '/r: git status --porcelain --untracked-files=no': ran(''),
  [`${WT}: git merge-base --is-ancestor main HEAD`]: ran(''),
  [`${WT}: git log --format=%h %s main..HEAD`]: ran('abc1 add x\nabc2 fix y\n'),
  [`${WT}: sh -c make test`]: ran('ok'),
  '/r: git rev-parse --short main': n => ran(n === 1 ? 'a000\n' : 'abc1\n'),
  '/r: git merge --ff-only feat': ran('Fast-forward'),
  '/r: sh -c ./post.sh': ran(''),
  [`/r: git worktree remove ${WT}`]: ran(''),
  '/r: git branch -d feat': ran('Deleted branch feat'),
})
const CONFIGURED = { '/r/.claude/rp-worktree.json': JSON.stringify({ preLand: 'make test', postLand: './post.sh' }) }

test('the landing refuses at each step in order, and merges nothing before the last check', async () => {
  // each step's bad answer; the n-th case keeps the steps before it good
  const bad: [string, Ran, RegExp][] = [
    [`${WT}: git status --porcelain`, ran(' M src/a.ts\n'), /the worktree \/r\/.claude\/worktrees\/feat has uncommitted changes/],
    ['/r: git symbolic-ref --quiet --short HEAD', ran('feat-2\n'), /the main tree \/r has feat-2 checked out, not main/],
    ['/r: git status --porcelain --untracked-files=no', ran(' M Makefile\n'), /the main tree \/r has uncommitted changes to tracked files/],
    [`${WT}: git merge-base --is-ancestor main HEAD`, ran('', 1), /rebase first: feat does not contain main/],
    [`${WT}: git log --format=%h %s main..HEAD`, ran(''), /feat has no commit that is not on main; nothing to land/],
    [`${WT}: sh -c make test`, ran('', 2, 'test failed: x'), /preLand exited 2 in .*nothing was merged:\ntest failed: x/],
    ['/r: git merge --ff-only feat', ran('', 128, 'fatal: Not possible to fast-forward'), /git merge --ff-only feat failed in \/r; nothing was merged/],
  ]
  for (let i = 0; i < bad.length; i++) {
    const answers = happy()
    for (const [key, answer] of bad.slice(i)) answers[key] = answer
    const host = fake({ ...REPO, files: CONFIGURED, answers })
    const repo = await readRepo(host, '/r')
    if (!repo) throw new Error('no repo')
    const text = await land(host, repo, `${WT}/src`, { leave: async () => true })
    expect(text).toMatch(/^Not landed: /)
    expect(text).toMatch(bad[i]?.[2] ?? /never/)
    // nothing past the refusing step ran: no merge but the refused one, no removal
    expect(host.calls.filter(c => c.includes('merge --ff-only')).length).toBe(i === bad.length - 1 ? 1 : 0)
    expect(host.calls.some(c => c.includes('worktree remove') || c.includes('branch -d'))).toBe(false)
  }
})

test('the landing reports the commits, runs the hooks, and removes the worktree and branch', async () => {
  const host = fake({ ...REPO, files: CONFIGURED, answers: happy() })
  const repo = await readRepo(host, '/r')
  if (!repo) throw new Error('no repo')
  const text = await land(host, repo, WT, { leave: async () => true })
  expect(text.split('\n')).toEqual([
    'Landed 2 commits of feat on main in /r (a000..abc1):',
    '- abc1 add x',
    '- abc2 fix y',
    'preLand passed.',
    'postLand passed.',
    `Removed the worktree ${WT} and deleted the branch feat.`,
  ])
  // the order of the work: preLand before the merge, postLand after it, never --force
  const order = host.calls.filter(c => /sh -c|merge --ff-only|worktree remove|branch -d/.test(c))
  expect(order).toEqual([`${WT}: sh -c make test`, '/r: git merge --ff-only feat', '/r: sh -c ./post.sh', `/r: git worktree remove ${WT}`, '/r: git branch -d feat'])
  expect(host.calls.some(c => c.includes('--force') || c.includes('branch -D') || c.includes('rebase'))).toBe(false)
})

test('the landing keeps the worktree when the session cannot leave it, and refuses outside a worktree', async () => {
  const host = fake({ ...REPO, answers: happy() })
  const repo = await readRepo(host, '/r')
  if (!repo) throw new Error('no repo')
  const kept = await land(host, repo, WT, { leave: async () => false })
  expect(kept).toMatch(/^Landed 2 commits/)
  expect(kept).toMatch(/are kept: this session runs in that folder/)
  expect(host.calls.some(c => c.includes('worktree remove'))).toBe(false)
  expect(await land(host, repo, '/r/src', { leave: async () => true })).toMatch(/runs in the main tree of \/r, not in a worktree/)
  const broken = await readRepo(fake({ ...REPO, files: { '/r/.claude/rp-worktree.json': '{"gate": 1}' } }), '/r')
  if (!broken) throw new Error('no repo')
  expect(await land(host, broken, WT, { leave: async () => true })).toMatch(/rp-worktree\.json does not parse \(unknown key/)
})

test('pruning: landed by content, never the unsafe ones, -D only beside its empty cherry list', async () => {
  const world: World = {
    branches: ['main', 'feat', 'reb', 'wip', 'fresh', 'dirty', 'mine', 'old', 'side'],
    trees: [
      { path: '/r', branch: 'main' },
      { path: '/w/feat', branch: 'feat' },
      { path: '/w/fresh', branch: 'fresh' },
      { path: '/w/dirty', branch: 'dirty' },
      { path: '/w/mine', branch: 'mine' },
      { path: '/w/gate', isDetached: true },
      { path: '/w/old', branch: 'old' },
    ],
    gone: ['/w/old'],
    tracked: [],
    answers: {
      '/r: git worktree prune': ran(''),
      '/r: git symbolic-ref --quiet --short HEAD': ran('main\n'),
      '/r: git for-each-ref --format=%(refname:short) refs/heads/': ran('dirty\nfeat\nfresh\nmain\nmine\nold\nreb\nside\nwip\n'),
      // landed by fast-forward: nothing of its own left, and a history of commits
      '/r: git cherry main feat': ran(''),
      '/r: git reflog show --format=%gs refs/heads/feat': ran('commit: b\ncommit: a\nbranch: Created from HEAD\n'),
      '/w/feat: git status --porcelain': ran(''),
      '/r: du -sh /w/feat': ran('1.5G\t/w/feat\n'),
      '/r: git merge-base --is-ancestor feat main': ran(''),
      // landed by rebase: every patch is on main under another sha
      '/r: git cherry main reb': ran('- 1111\n- 2222\n'),
      '/r: git merge-base --is-ancestor reb main': ran('', 1),
      // not landed
      '/r: git cherry main wip': ran('- 3333\n+ 4444\n'),
      // just entered, no commit yet
      '/r: git cherry main fresh': ran(''),
      '/r: git reflog show --format=%gs refs/heads/fresh': ran('branch: Created from HEAD\n'),
      // landed, but the tree has an untracked file
      '/r: git cherry main dirty': ran('- 5555\n'),
      '/w/dirty: git status --porcelain': ran('?? notes.txt\n'),
      // landed, but this session runs in it
      '/r: git cherry main mine': ran('- 6666\n'),
      // landed, its folder already gone: only the branch goes
      '/r: git cherry main old': ran('- 7777\n'),
      '/r: git merge-base --is-ancestor old main': ran(''),
      '/r: git cherry main side': ran('+ 8888\n'),
      '/r: git worktree remove /w/feat': ran(''),
      '/r: git branch -d feat': ran(''),
      '/r: git branch -D reb': ran(''),
      '/r: git branch -d old': ran(''),
    },
  }
  const host = fake(world)
  const repo = await readRepo(host, '/r')
  if (!repo) throw new Error('no repo')
  const s = await scan(host, repo, '/w/mine/src')
  expect(s.landed.map(l => `${l.branch} ${l.flag}`)).toEqual(['feat -d', 'old -d', 'reb -D'])
  expect(pruneLine(s)).toBe('Prune: 3 landed branches can go: feat (worktree /w/feat, 1.5G), old (worktree /w/old), reb; /worktree prune (mcp__rp__worktree_prune) removes them.')
  expect(s.kept.join('\n')).toMatch(/fresh: no commit of its own yet/)
  expect(s.kept.join('\n')).toMatch(/dirty: landed, but its worktree \/w\/dirty has 1 changed or untracked path/)
  expect(s.kept.join('\n')).toMatch(/mine: landed, but this session runs in its worktree/)

  const text = await prune(host, repo, '/w/mine/src')
  expect(text).toMatch(/- removed worktree \/w\/feat \(1\.5G\)\n- deleted branch feat \(-d: an ancestor of the main branch\)/)
  expect(text).toMatch(/- deleted branch reb \(-D: not an ancestor; git cherry lists no unlanded commit: - 1111, - 2222\)/)
  expect(text).toMatch(/- deleted branch old \(-d/)
  // never --force, never the detached tree, the unlanded, the dirty, the fresh or the own one
  const writes = host.calls.filter(c => /worktree remove|branch -[dD]/.test(c))
  expect(writes).toEqual(['/r: git worktree remove /w/feat', '/r: git branch -d feat', '/r: git branch -d old', '/r: git branch -D reb'])
  expect(host.calls.some(c => c.includes('--force'))).toBe(false)

  // the branch checked out in the main tree is never a candidate
  const onSide = fake({ ...world, answers: { ...world.answers, '/r: git symbolic-ref --quiet --short HEAD': ran('feat\n') } })
  const r2 = await readRepo(onSide, '/r')
  if (!r2) throw new Error('no repo')
  expect((await scan(onSide, r2, '/w/mine')).landed.map(l => l.branch)).toEqual(['old', 'reb'])
  expect(pruneLine({ landed: [], kept: ['x'] })).toBeUndefined()
})

// The whole plugin over a fake engine: a session in the main tree of /r.
test('a prompt carries the place as context; the system prompt carries the rule alone', async ($, on) => {
  const git: Record<string, string> = {
    'rev-parse --verify --quiet refs/heads/main': 'abc',
    'worktree list --porcelain': 'worktree /r\nHEAD 0123\nbranch refs/heads/main\n',
    'symbolic-ref --quiet --short HEAD': 'main\n',
    'for-each-ref --format=%(refname:short) refs/heads/': 'main\n',
  }
  const result = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('process.run', (_, e) => {
    if (e.argv[0] !== 'git') return result('', 1)
    const out = git[e.argv.slice(1).join(' ')]
    return out === undefined ? result('', 1) : result(out)
  })
  on('session.repo', () => ({ value: { root: '/r', remote: null, internal: false, name: null } }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.root', () => ({ value: '/r' }))
  on('session.id', () => ({ value: 'engine-id' }))
  on('session.model', () => ({ value: 'opus' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', (_, e) => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: e.path.replace(/\/$/, '') } }))
  on('fs.read', (_, e) => {
    throw new Error(`ENOENT ${e.path}`)
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', () => ({ value: undefined }))
  on('env.get', () => ({ value: '/home/u' }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__rp__${e.name}` } }))
  on('agent.register', (_, e) => ({ value: { agent: `rp:${e.name}` } }))
  on('tool.list', () => ({ value: [] }))
  on('classic.UserPromptSubmit', () => ({}))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'engine', scope: 'shared' as const }] }))
  await $.session.start({ cwd: '/r', surface: 'desktop', isInteractive: true })

  const composed = await $.prompt.compose({ model: 'opus', promptModel: 'opus', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const mine = composed.sections.find(x => x.id === 'rp:worktree')
  expect(mine?.text.split('\n').length).toBe(3)
  expect(mine?.text).not.toMatch(/Here:/)
  const asked = await $.classic.UserPromptSubmit({ prompt: 'fix the bug', permission_mode: 'default' } as never)
  expect(asked.additionalContext).toEqual(['Here: main tree of /r: code edits are refused, enter a worktree first.'])
})
