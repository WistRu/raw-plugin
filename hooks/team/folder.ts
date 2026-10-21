// The team folder on disk, through `$.fs`: where it is, what is in it, and
// the small reads and writes every hook shares. Every write of a shared JSON
// file goes through a lock and a rename, because several sessions write
// them. Nothing here decides.

import type { EngineInterface } from 'claude-code'

import type { Team } from './card'
import { cardText } from './card'
import type { Ledger } from './ledger'
import { emptyLedger } from './ledger'

export const TEAMS = '.claude/teams'
// A lock older than this is a dead session's and is taken over.
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 10_000
const LOCK_STEP_MS = 100
// The plugin's own registry of which session is in which team.
const BIND_KEY = 'team:bind'

// Where teams live for this session: under the repository's main tree when
// there is one (a worktree shares it), else under the user's home.
export async function teamsDir($: EngineInterface): Promise<string> {
  const repo = await $.session.repo().catch(() => null)
  if (repo) return `${repo.root}/${TEAMS}`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return `${home && home.length > 0 ? `${home}/.claude` : await $.session.root()}/teams`
}

export const teamFile = (dir: string) => `${dir}/team.json`
export const ledgerFile = (dir: string) => `${dir}/tasks.json`
export const noteFile = (dir: string, role: string) => `${dir}/handoff/${role}.md`
export const stateFile = (dir: string, role: string) => `${dir}/handoff/${role}.state.json`
export const inboxDir = (dir: string, role: string) => `${dir}/inbox/${role}`

const rand = () => Math.random().toString(36).slice(2, 8)

// A missing file is the fallback; a file that does not parse is an error,
// never an empty value that the next write would make permanent.
export async function readJson<T>($: EngineInterface, path: string, fallback: T): Promise<T> {
  if (!(await $.fs.exists(path))) return fallback
  const text = await $.fs.read(path)
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${path} does not parse; another session may be writing it, retry`)
  }
}

// Written whole to a temporary name, then renamed: a reader sees the old
// file or the new one, never a half.
export async function writeJson($: EngineInterface, path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${rand()}.tmp`
  await $.fs.write(tmp, JSON.stringify(value, null, 2) + '\n')
  const { exitCode, stderr } = await $.process.run(['mv', '-f', tmp, path], { timeoutMs: 5000 })
  if (exitCode !== 0) throw new Error(`mv ${tmp} ${path} exited ${exitCode}: ${stderr.trim()}`)
}

// One lock per team folder: `mkdir` is atomic, so whoever makes the
// directory holds it. A lock a dead session left is taken over after
// LOCK_STALE_MS.
export async function withLock<T>($: EngineInterface, dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = `${dir}/.lock`
  const deadline = (await $.clock.now()) + LOCK_WAIT_MS
  for (;;) {
    const made = await $.process.run(['mkdir', lock], { timeoutMs: 5000 })
    if (made.exitCode === 0) break
    const now = await $.clock.now()
    const age = await $.fs.stat(lock).then(s => now - s.mtimeMs).catch(() => 0)
    if (age > LOCK_STALE_MS) {
      await $.process.run(['rmdir', lock], { timeoutMs: 5000 }).catch(() => undefined)
      continue
    }
    if (now > deadline) throw new Error(`${lock} is held by another session; retry`)
    await $.clock.sleep(LOCK_STEP_MS)
  }
  try {
    return await fn()
  } finally {
    await $.process.run(['rmdir', lock], { timeoutMs: 5000 }).catch(() => undefined)
  }
}

export function readTeam($: EngineInterface, dir: string): Promise<Team | null> {
  return readJson<Team | null>($, teamFile(dir), null)
}

export function readLedger($: EngineInterface, dir: string): Promise<Ledger> {
  return readJson<Ledger>($, ledgerFile(dir), emptyLedger())
}

// Read, change, write, under the folder's lock: the only way a shared file
// is changed after the team is laid out.
export async function updateTeam($: EngineInterface, dir: string, change: (team: Team) => Team): Promise<Team> {
  return withLock($, dir, async () => {
    const team = await readTeam($, dir)
    if (!team) throw new Error(`no team at ${dir}`)
    const next = change(team)
    await writeJson($, teamFile(dir), next)
    return next
  })
}

export async function updateLedger<T>($: EngineInterface, dir: string, change: (ledger: Ledger) => { ledger: Ledger; out: T }): Promise<T> {
  return withLock($, dir, async () => {
    const { ledger, out } = change(await readLedger($, dir))
    await writeJson($, ledgerFile(dir), ledger)
    return out
  })
}

// ---- Which session is in which team ------------------------------------------

export type Binding = { dir: string; role: string }
type Registry = Record<string, Binding>

// The plugin's store survives sessions and hot reloads on this machine, so a
// session finds its team by its own id without scanning folders.
export async function bindSession($: EngineInterface, id: string, binding: Binding): Promise<void> {
  const reg = ((await $.store.get(BIND_KEY)) ?? {}) as Registry
  await $.store.set(BIND_KEY, { ...reg, [id]: binding })
}

export async function unbindSession($: EngineInterface, id: string): Promise<void> {
  const reg = ((await $.store.get(BIND_KEY)) ?? {}) as Registry
  if (!(id in reg)) return
  const { [id]: _gone, ...rest } = reg
  await $.store.set(BIND_KEY, rest)
}

export type Membership = { team: Team; role: string | 'lead' }

export async function membership($: EngineInterface): Promise<Membership | undefined> {
  const id = await $.session.id()
  const reg = ((await $.store.get(BIND_KEY).catch(() => undefined)) ?? {}) as Registry
  const bound = reg[id]
  if (bound) {
    const team = await readTeam($, bound.dir).catch(() => null)
    if (team && !team.closed && (bound.role === 'lead' ? team.lead === id : team.roles.some(r => r.name === bound.role && r.sessionId === id)))
      return { team, role: bound.role }
  }
  // The registry may be empty (a store cleared, another machine): the
  // folders are the fallback.
  for (const team of await listTeams($)) {
    if (team.closed) continue
    if (team.lead === id) return { team, role: 'lead' }
    const role = team.roles.find(r => r.sessionId === id)
    if (role) return { team, role: role.name }
  }
  return undefined
}

// Every team folder under the teams dir, newest first; a folder without
// team.json is skipped.
export async function listTeams($: EngineInterface): Promise<Team[]> {
  const base = await teamsDir($)
  const entries = await $.fs.list(base).catch(() => [])
  const teams: Team[] = []
  for (const e of entries) {
    if (e.kind !== 'dir') continue
    const t = await readTeam($, `${base}/${e.name}`).catch(() => null)
    if (t) teams.push(t)
  }
  return teams.sort((a, b) => b.created.localeCompare(a.created))
}

const NOTIFY_SH = `#!/bin/sh
# Wake a role of this team from a shell job: sh notify.sh <role> "<what>" [<path>]
# Writes one event file into the role's inbox; the lead's session delivers it.
role="$1"; what="$2"; path="$3"
case "$role" in ''|*/*|.*) echo "notify.sh: bad role name" >&2; exit 2;; esac
dir="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$dir/inbox/$role"
stamp="$(date -u +%Y-%m-%dT%H%M%S%3NZ 2>/dev/null || date -u +%Y-%m-%dT%H%M%SZ)"
f="$dir/inbox/$role/$stamp-job-$$.md"
{ echo "from: job"; echo "at: $stamp"; [ -n "$path" ] && echo "path: $path"; echo; echo "$what"; } > "$f.tmp" && mv "$f.tmp" "$f"
`

// Lays the folder out: the card, an empty ledger, a note per role, the
// inboxes, notify.sh, and a .gitignore so nothing of it is ever committed.
export async function layOut($: EngineInterface, team: Team): Promise<void> {
  await writeJson($, teamFile(team.dir), team)
  await writeJson($, ledgerFile(team.dir), emptyLedger())
  await $.fs.write(`${team.dir}/CARD.md`, cardText(team) + '\n')
  await $.fs.write(`${team.dir}/.gitignore`, '*\n')
  await $.fs.write(`${team.dir}/notify.sh`, NOTIFY_SH)
  for (const r of team.roles) {
    await $.fs.write(noteFile(team.dir, r.name), `# ${r.name} -- handoff\n\n## Queue (${team.created}; nothing running)\n\n- (empty)\n\n## Inbox\n`)
    await $.fs.write(`${inboxDir(team.dir, r.name)}/.keep`, '')
  }
  await $.fs.write(`${inboxDir(team.dir, 'lead')}/.keep`, '')
}

// One event file into a role's inbox; the owner is woken by whoever polls.
// The name carries milliseconds and a random tail, so two events in one
// second never share a file.
export async function writeEvent($: EngineInterface, dir: string, role: string, from: string, text: string, path?: string): Promise<string> {
  const at = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '')
  const file = `${inboxDir(dir, role)}/${at}-${from}-${rand()}.md`
  const body = [`from: ${from}`, `at: ${at}`, ...(path ? [`path: ${path}`] : []), '', text, ''].join('\n')
  await $.fs.write(file, body)
  return file
}

export type Event = { file: string; name: string; text: string }

// Unread events of a role, oldest first (the `seen/` folder is skipped).
export async function unreadEvents($: EngineInterface, dir: string, role: string): Promise<Event[]> {
  const folder = inboxDir(dir, role)
  const entries = await $.fs.list(folder).catch(() => [])
  const files = entries.filter(e => e.kind === 'file' && e.name.endsWith('.md')).sort((a, b) => a.name.localeCompare(b.name))
  const out: Event[] = []
  for (const e of files) {
    const text = await $.fs.read(`${folder}/${e.name}`).catch(() => '')
    out.push({ file: `${folder}/${e.name}`, name: e.name, text })
  }
  return out
}

// An acknowledged event is moved under seen/; a move that fails is reported,
// so an event is never resent for ever in silence.
export async function ackEvent($: EngineInterface, dir: string, role: string, event: Event): Promise<void> {
  const seen = `${inboxDir(dir, role)}/seen`
  await $.fs.write(`${seen}/.keep`, '')
  const { exitCode, stderr } = await $.process.run(['mv', '-f', event.file, `${seen}/${event.name}`], { timeoutMs: 5000 })
  if (exitCode !== 0) throw new Error(`cannot move ${event.file} to seen/: ${stderr.trim()}`)
}

// The queue block of a note: from its `## Queue` heading to the next heading.
export function queueBlock(note: string): string {
  const lines = note.split('\n')
  const start = lines.findIndex(l => l.startsWith('## Queue'))
  if (start < 0) return ''
  const out: string[] = []
  for (const l of lines.slice(start)) {
    if (out.length > 0 && l.startsWith('## ')) break
    out.push(l)
  }
  return out.join('\n').trim().split('\n').slice(0, 40).join('\n')
}

// The note with its queue block replaced (or added first) by a new heading
// and body; everything else stays as it was.
export function replaceQueue(note: string, heading: string, body: string): string {
  const lines = note.split('\n')
  const start = lines.findIndex(l => l.startsWith('## Queue'))
  const block = [`## Queue (${heading})`, '', body.trim(), '']
  if (start < 0) {
    const hasTitle = lines[0]?.startsWith('# ')
    const title = hasTitle ? [lines[0], ''] : []
    let rest = hasTitle ? lines.slice(1) : lines
    while (rest[0] === '') rest = rest.slice(1)
    return [...title, ...block, ...rest].join('\n')
  }
  let end = start + 1
  while (end < lines.length && !(lines[end] ?? '').startsWith('## ')) end += 1
  return [...lines.slice(0, start), ...block, ...lines.slice(end)].join('\n')
}

export async function appendInbox($: EngineInterface, dir: string, role: string, line: string): Promise<void> {
  const path = noteFile(dir, role)
  const note = await $.fs.read(path).catch(() => `# ${role} -- handoff\n\n## Inbox\n`)
  const text = note.includes('\n## Inbox') ? note.replace(/\n## Inbox\n?/, m => `${m.endsWith('\n') ? m : m + '\n'}- ${line}\n`) : `${note}\n## Inbox\n- ${line}\n`
  await $.fs.write(path, text)
}
