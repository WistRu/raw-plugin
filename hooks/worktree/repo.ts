// What the worktree module knows of a repository, read through a Host so the
// tests can stand a fake repository in for git. Every path compared is a
// real path: a root reached through a symlink is the same tree as its target.

export type Ran = { code: number; out: string; err: string }

// The engine beneath, narrowed to what this module asks of it.
export type Host = {
  // A command by its argument vector, no shell; git runs with hooks off.
  run: (argv: readonly string[], cwd: string, timeoutMs?: number) => Promise<Ran>
  // The real path of a path that may not exist yet: its nearest existing
  // ancestor resolved, the rest appended. Undefined when nothing resolves.
  real: (path: string) => Promise<string | undefined>
  // A file's text, undefined when it cannot be read.
  read: (path: string) => Promise<string | undefined>
  exists: (path: string) => Promise<boolean>
}

// `.claude/rp-worktree.json` in the main tree; every key optional.
export type Config = {
  // Path prefixes that alone count as code; absent, every tracked file does.
  code?: string[]
  // Run in the worktree before the merge; a non-zero exit refuses the landing.
  preLand?: string | string[]
  // Run in the main tree after the merge.
  postLand?: string | string[]
}

export const CONFIG_FILE = '.claude/rp-worktree.json'

export type Tree = { path: string; branch?: string; isDetached: boolean }

export type Repo = {
  // The main working tree, as the engine names it and as a real path.
  root: string
  mainReal: string
  main: string
  // Every registered worktree, the main tree first, paths real.
  trees: Tree[]
  config: Config
  // Why the config file was not taken, when it exists and does not parse.
  configError?: string
}

const lines = (text: string) => text.split('\n').filter(l => l.length > 0)

// The main branch: what origin/HEAD points at, else main, else master,
// each only when a local branch of that name exists.
export async function mainBranch(host: Host, root: string): Promise<string | undefined> {
  const has = async (b: string) => (await host.run(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${b}`], root)).code === 0
  const head = await host.run(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root)
  const fromOrigin = head.code === 0 ? head.out.trim().replace(/^origin\//, '') : ''
  for (const b of [fromOrigin, 'main', 'master']) if (b && (await has(b))) return b
  return undefined
}

// `git worktree list --porcelain`, each path made real.
export async function listTrees(host: Host, root: string): Promise<Tree[]> {
  const ran = await host.run(['git', 'worktree', 'list', '--porcelain'], root)
  if (ran.code !== 0) return []
  const trees: Tree[] = []
  let cur: Tree | undefined
  for (const line of ran.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), isDetached: false }
      trees.push(cur)
    } else if (cur && line.startsWith('branch refs/heads/')) cur.branch = line.slice('branch refs/heads/'.length)
    else if (cur && line === 'detached') cur.isDetached = true
  }
  for (const t of trees) t.path = (await host.real(t.path)) ?? t.path
  return trees
}

export function parseConfig(text: string): { config: Config } | { error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return { error: `not JSON: ${String(err)}` }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not a JSON object' }
  const o = raw as Record<string, unknown>
  const unknown = Object.keys(o).filter(k => !['code', 'preLand', 'postLand'].includes(k))
  if (unknown.length) return { error: `unknown key(s): ${unknown.join(', ')}; only code, preLand and postLand are read` }
  const isArgv = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every(x => typeof x === 'string')
  const config: Config = {}
  if (o.code !== undefined) {
    if (!Array.isArray(o.code) || !o.code.every(x => typeof x === 'string')) return { error: 'code must be a list of path prefixes' }
    config.code = o.code.map(p => p.replace(/^\.?\//, '').replace(/\/+$/, '')).filter(p => p.length > 0)
  }
  for (const key of ['preLand', 'postLand'] as const) {
    const v = o[key]
    if (v === undefined) continue
    if (typeof v !== 'string' && !isArgv(v)) return { error: `${key} must be a command line or an argument list` }
    config[key] = v as string | string[]
  }
  return { config }
}

// Undefined when the session is in no repository, or one with no main
// branch: the module is silent there.
export async function readRepo(host: Host, root: string): Promise<Repo | undefined> {
  const main = await mainBranch(host, root)
  if (!main) return undefined
  const mainReal = (await host.real(root)) ?? root
  const trees = await listTrees(host, root)
  if (!trees.some(t => t.path === mainReal)) trees.unshift({ path: mainReal, isDetached: false })
  const text = await host.read(`${mainReal}/${CONFIG_FILE}`)
  if (text === undefined) return { root, mainReal, main, trees, config: {} }
  const parsed = parseConfig(text)
  return 'error' in parsed
    ? { root, mainReal, main, trees, config: {}, configError: parsed.error }
    : { root, mainReal, main, trees, config: parsed.config }
}

const isUnder = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)

// The working tree a real path belongs to: the deepest registered tree that
// holds it, so a worktree nested inside the main tree (`.claude/worktrees/x`)
// owns its own files. Undefined outside every tree of the repository.
export function ownerOf(repo: Repo, real: string): Tree | undefined {
  let best: Tree | undefined
  for (const t of repo.trees) if (isUnder(real, t.path) && (!best || t.path.length > best.path.length)) best = t
  return best
}

export const isMain = (repo: Repo, tree: Tree | undefined) => tree !== undefined && tree.path === repo.mainReal

// The tracked files at or under a real path of the main tree, relative to
// its root, kept to the `code` prefixes when the config names any.
export async function trackedCode(host: Host, repo: Repo, real: string): Promise<string[]> {
  const ran = await host.run(['git', 'ls-files', '-z', '--', real], repo.mainReal)
  if (ran.code !== 0) return []
  const files = ran.out.split('\0').filter(f => f.length > 0)
  const code = repo.config.code
  return code === undefined ? files : files.filter(f => code.some(p => isUnder(f, p)))
}

export { lines }

// Where the session stands, for the prompt section.
export type Place =
  | { kind: 'main'; root: string }
  | { kind: 'worktree'; path: string; branch?: string; ahead: number; isDirty: boolean }

export async function placeOf(host: Host, repo: Repo, cwdReal: string): Promise<Place> {
  const tree = ownerOf(repo, cwdReal)
  if (!tree || isMain(repo, tree)) return { kind: 'main', root: repo.root }
  const count = await host.run(['git', 'rev-list', '--count', `${repo.main}..HEAD`], tree.path)
  const status = await host.run(['git', 'status', '--porcelain'], tree.path)
  return { kind: 'worktree', path: tree.path, branch: tree.branch, ahead: Number(count.out.trim()) || 0, isDirty: status.out.trim().length > 0 }
}
