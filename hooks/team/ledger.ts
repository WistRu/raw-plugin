// The team's task ledger as pure functions over JSON data: statuses,
// dependencies and what each transition wakes. Ported from BTC5Model's
// scripts/role_tasks.py (2026-10-03), the file system left out so it is
// testable without a host.

export type Status = 'blocked' | 'ready' | 'in_progress' | 'awaiting_verify' | 'done' | 'failed' | 'dropped'
export const OPEN: readonly Status[] = ['blocked', 'ready', 'in_progress', 'awaiting_verify']

export type Artifact = { path: string; sha256?: string }
export type HistoryRow = { at: string; by: string; status: Status; note?: string }

export type Task = {
  id: string
  title: string
  owner: string
  status: Status
  depends_on: string[]
  verifier: string | null
  artifacts: Artifact[]
  created: string
  updated: string
  note?: string
  // The critic's last read of the task's result, owed before awaiting_verify.
  critic?: { at: string; summary: string }
  history: HistoryRow[]
}

export type Ledger = { next: number; tasks: Task[] }

// One wake the ledger owes after a transition: who, why, about which task.
export type Wake = { role: string; kind: 'ready' | 'verify' | 'decide'; task: string; text: string }

export const emptyLedger = (): Ledger => ({ next: 1, tasks: [] })

const isOpen = (s: Status) => OPEN.includes(s)

// `blocked` and `ready` are never typed: they follow from the dependencies.
export function recompute(ledger: Ledger): Ledger {
  const byId = new Map(ledger.tasks.map(t => [t.id, t]))
  const tasks = ledger.tasks.map(t => {
    if (t.status !== 'blocked' && t.status !== 'ready') return t
    const open = t.depends_on.some(d => {
      const dep = byId.get(d)
      return dep === undefined || dep.status !== 'done'
    })
    return { ...t, status: open ? 'blocked' : 'ready' } as Task
  })
  return { ...ledger, tasks }
}

export type AddArgs = { title: string; owner: string; depends_on?: string[]; verifier?: string | null; note?: string }

// Why `deps` cannot be the dependencies of `id`: an unknown id, itself, or a
// ring back to it through other tasks' dependencies. Undefined when fine.
export function checkDeps(ledger: Ledger, id: string, deps: string[]): string | undefined {
  const byId = new Map(ledger.tasks.map(t => [t.id, t]))
  for (const d of deps) {
    if (d === id) return `${id} cannot depend on itself`
    if (!byId.has(d)) return `no task ${d} to depend on`
  }
  // Walk from each dependency down its own dependencies: reaching `id`
  // closes a ring.
  const seen = new Set<string>()
  const stack = [...deps]
  while (stack.length > 0) {
    const cur = stack.pop() ?? ''
    if (cur === id) return `${id} and ${deps.join(', ')} would wait on each other in a ring`
    if (seen.has(cur)) continue
    seen.add(cur)
    stack.push(...(byId.get(cur)?.depends_on ?? []))
  }
  return undefined
}

export function addTask(ledger: Ledger, args: AddArgs, at: string, by: string): { ledger: Ledger; task: Task } | { error: string } {
  const id = `T-${String(ledger.next).padStart(4, '0')}`
  const bad = checkDeps(ledger, id, args.depends_on ?? [])
  if (bad) return { error: bad }
  const task: Task = {
    id,
    title: args.title,
    owner: args.owner,
    status: 'ready',
    depends_on: args.depends_on ?? [],
    verifier: args.verifier ?? null,
    artifacts: [],
    created: at,
    updated: at,
    note: args.note,
    history: [{ at, by, status: 'ready', note: 'added' }],
  }
  const next = recompute({ next: ledger.next + 1, tasks: [...ledger.tasks, task] })
  return { ledger: next, task: next.tasks.find(t => t.id === id) ?? task }
}

export type SetArgs = {
  id: string
  status?: Status
  note?: string
  artifact?: Artifact
  depends_on?: string[]
  verifier?: string | null
  owner?: string
  critic?: { at: string; summary: string }
  force?: boolean
}

export type SetResult = { ledger: Ledger; task: Task; wakes: Wake[] } | { error: string }

// Every transition that frees a dependent or hands a result to a verifier
// returns the wakes it owes. `done` with an open dependency is refused
// unless forced; `failed` and `dropped` never unblock a dependent: its owner
// gets `decide`. A changed owner wakes nobody, and a reopened task does not
// re-block its dependents: both are left for later.
export function setTask(ledger: Ledger, args: SetArgs, at: string, by: string): SetResult {
  const before = ledger.tasks.find(t => t.id === args.id)
  if (!before) return { error: `no task ${args.id}` }
  if (args.status === 'blocked' || args.status === 'ready')
    return { error: `${args.status} is computed from the dependencies, never set` }
  if (args.depends_on) {
    const bad = checkDeps(ledger, args.id, args.depends_on)
    if (bad) return { error: bad }
  }
  if (args.status === 'done' && !args.force) {
    const open = before.depends_on.filter(d => ledger.tasks.find(t => t.id === d)?.status !== 'done')
    if (open.length > 0) return { error: `${args.id} still waits on ${open.join(', ')}; pass force to close it anyway` }
  }
  const critic = args.critic ?? before.critic
  if (args.status === 'awaiting_verify' && before.verifier && !critic && !args.force)
    return { error: `${args.id} goes to ${before.verifier} only after the critic has read it (team_critic with task ${args.id}); pass force to skip, saying why in the note` }
  const wasReady = new Set(ledger.tasks.filter(t => t.status === 'ready').map(t => t.id))
  const updated: Task = {
    ...before,
    status: args.status ?? before.status,
    note: args.note ?? before.note,
    critic,
    artifacts: args.artifact ? [...before.artifacts, args.artifact] : before.artifacts,
    depends_on: args.depends_on ?? before.depends_on,
    verifier: args.verifier === undefined ? before.verifier : args.verifier,
    owner: args.owner ?? before.owner,
    updated: at,
    history: args.status || args.note || args.critic
      ? [...before.history, { at, by, status: args.status ?? before.status, note: args.note ?? (args.critic ? `critic: ${args.critic.summary}` : undefined) }]
      : before.history,
  }
  const next = recompute({ ...ledger, tasks: ledger.tasks.map(t => (t.id === args.id ? updated : t)) })
  const task = next.tasks.find(t => t.id === args.id) ?? updated
  const wakes: Wake[] = []
  for (const t of next.tasks) {
    if (t.status === 'ready' && !wasReady.has(t.id) && t.id !== task.id)
      wakes.push({ role: t.owner, kind: 'ready', task: t.id, text: `${t.id} is ready: ${t.title} (${task.id} closed)` })
  }
  if (args.status === 'awaiting_verify' && task.verifier)
    wakes.push({ role: task.verifier, kind: 'verify', task: task.id, text: `${task.id} awaits your verdict: ${task.title}` })
  if (args.status === 'failed' || args.status === 'dropped') {
    for (const t of next.tasks) {
      if (isOpen(t.status) && t.depends_on.includes(task.id))
        wakes.push({ role: t.owner, kind: 'decide', task: t.id, text: `${task.id} ended ${args.status}: ${t.id} waits on it; re-point its depends_on or drop it` })
    }
  }
  return { ledger: next, task, wakes }
}

export const openTasks = (ledger: Ledger): Task[] => ledger.tasks.filter(t => isOpen(t.status))

// The board as text, one section per owner, open tasks only.
export function board(ledger: Ledger, at: string): string {
  const open = openTasks(ledger)
  const lines = [`# Task board (${at}) -- ${open.length} open task(s)`]
  const owners = [...new Set(open.map(t => t.owner))].sort()
  for (const owner of owners) {
    lines.push('', `## ${owner}`)
    for (const t of open.filter(t => t.owner === owner)) {
      const waits = t.status === 'blocked' ? ` -- waits on ${t.depends_on.join(', ')}` : ''
      const ver = t.verifier ? ` (verifier ${t.verifier})` : ''
      lines.push(`- ${t.id} **${t.status}** ${t.title}${ver}${waits}`)
    }
  }
  const done = ledger.tasks.filter(t => t.status === 'done').length
  const gone = ledger.tasks.filter(t => t.status === 'failed' || t.status === 'dropped').length
  lines.push('', `_${done} done, ${gone} failed or dropped._`)
  return lines.join('\n')
}
