// team: a team of sessions for one task. `/team <task>` has the model draft
// the roles; `mcp__rp__team_create` lays the team folder out and starts one
// session per role (Claude Desktop) or one subagent per role (elsewhere);
// the ledger, the inboxes and the handoff notes tie them together, and the
// lead's session draws the board in a pane.
//
// Ported from BTC5Model's convergence roles (2026-09-25..10-06): the card,
// the handoff note, role_tasks.py, role_inbox.py and the resume-role /
// role-handoff skills, each as a hook or a tool instead of a script.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptComposeSection, Timer } from 'claude-code'

import type { TeamView } from '../../types'
import type { Role, Team } from './card'
import { RULES, brief, cardText, leadSection, memberSection, slugify } from './card'
import type { Membership } from './folder'
import {
  ackEvent, appendInbox, inboxDir, layOut, listTeams, membership, noteFile, queueBlock, readLedger, readTeam, replaceQueue,
  stateFile, teamsDir, unreadEvents, writeEvent, writeLedger, writeTeam,
} from './folder'
import type { Ledger, SetArgs, Status, Wake } from './ledger'
import { addTask, board, setTask } from './ledger'

const PANE = 'team'
// How often the lead's session looks into the inboxes for events nobody
// delivered (a shell job's notify.sh, a message that found no session).
const POLL_MS = 60_000
// A cached membership is re-read this often (a role may have joined since).
const MEMBERSHIP_FRESH_MS = 60_000
// The desktop app's tool that starts a session; absent in a terminal.
const START_SESSION = 'mcp__ccd_session__start_session'

export const view = atom({ plugin: 'rp', key: 'team' } as const, null)

let me: Membership | undefined
let meAt = 0
let poll: Timer | undefined

type Input = Record<string, unknown>
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

async function stamp($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString().slice(0, 16) + 'Z'
}

async function who($: EngineInterface): Promise<Membership | undefined> {
  const now = await $.clock.now()
  if (me && now - meAt < MEMBERSHIP_FRESH_MS) return me
  me = await membership($).catch(() => undefined)
  meAt = now
  return me
}

const answer = (text: string, isReadOnly = false) => (isReadOnly ? { result: text, text, isReadOnly: true as const } : { result: text, text })

// ---- Messages between members ---------------------------------------------

// One message to a role: its session when it has one, else its agent; the
// event file stays unread when nothing could be delivered, for the poll.
async function deliver($: EngineInterface, team: Team, role: string, from: string, text: string): Promise<boolean> {
  const body = `[rp team ${team.slug}] from ${from}: ${text}`
  const to = role === 'lead' ? { sessionId: team.lead } : (() => {
    const r = team.roles.find(x => x.name === role)
    return r?.sessionId ? { sessionId: r.sessionId } : r?.agentId ? { agentId: r.agentId } : undefined
  })()
  if (!to) return false
  const myId = await $.session.id()
  if ('sessionId' in to && to.sessionId === myId) return false
  const sent = await $.session.send({ to, text: body }).catch(() => ({ isDelivered: false as const }))
  return sent.isDelivered
}

async function notify($: EngineInterface, team: Team, role: string, from: string, text: string, path?: string): Promise<string> {
  const file = await writeEvent($, team.dir, role, from, text, path)
  const delivered = await deliver($, team, role, from, text)
  if (delivered) await ackEvent($, team.dir, role, { file, name: file.slice(file.lastIndexOf('/') + 1), text })
  return delivered ? `delivered to ${role}` : `written to ${role}'s inbox (no live session; the lead's poll delivers it)`
}

async function wake($: EngineInterface, team: Team, from: string, wakes: Wake[]): Promise<string[]> {
  const out: string[] = []
  for (const w of wakes) out.push(`${w.kind}: ${await notify($, team, w.role, from, w.text)}`)
  return out
}

// ---- The lead's poll --------------------------------------------------------

async function pollOnce($: EngineInterface, team: Team): Promise<void> {
  const fresh = (await readTeam($, team.dir)) ?? team
  if (fresh.closed) {
    poll?.cancel()
    poll = undefined
    return
  }
  for (const r of fresh.roles) {
    if (!r.active) continue
    for (const ev of await unreadEvents($, fresh.dir, r.name)) {
      if (await deliver($, fresh, r.name, 'inbox', ev.text)) await ackEvent($, fresh.dir, r.name, ev)
    }
  }
  const mine = await unreadEvents($, fresh.dir, 'lead')
  for (const ev of mine) {
    $.ui.log(`${$.plugin.name}: team ${fresh.slug}, event for the lead: ${ev.text.split('\n').at(-2) ?? ev.name}`)
    await appendInbox($, fresh.dir, 'lead', `${ev.name}: ${ev.text.trim().split('\n').at(-1) ?? ''}`)
    await ackEvent($, fresh.dir, 'lead', ev)
  }
  await refreshView($, fresh)
}

function armPoll($: EngineInterface, team: Team): void {
  poll?.cancel()
  poll = $.clock.every(POLL_MS, () => pollOnce($, team).catch(err => $.ui.log(`${$.plugin.name}: team poll failed: ${String(err)}`, { to: 'debug' })))
}

async function refreshView($: EngineInterface, team: Team): Promise<void> {
  const ledger = await readLedger($, team.dir)
  const roles: TeamView['roles'] = []
  for (const r of team.roles) {
    const s = await $.fs.read(stateFile(team.dir, r.name)).then(t => JSON.parse(t) as { at?: string; context?: number }).catch(() => ({}))
    roles.push({ name: r.name, isStarted: Boolean(r.sessionId ?? r.agentId), isActive: r.active, context: s.context, lastAt: s.at })
  }
  await update($, view, () => ({ slug: team.slug, goal: team.goal, roles, board: board(ledger, 'now') }))
}

// ---- Starting the members ---------------------------------------------------

async function startMembers($: EngineInterface, team: Team, ledger: Ledger): Promise<string[]> {
  const tools = (await $.tool.list()).map(t => t.name)
  const viaDesktop = tools.includes(START_SESSION)
  const notes: string[] = []
  for (const r of team.roles) {
    const first = ledger.tasks.find(t => t.owner === r.name && t.status === 'ready')
    const text = brief(team, r, first)
    if (viaDesktop) {
      const ran = await $.tool.call({
        tool: START_SESSION,
        initiation: 'user_asked',
        title: `${team.slug}: ${r.name}`.slice(0, 59),
        prompt: text,
        background: `Team "${team.slug}" of the plugin rp, one session per role. Goal: ${team.goal}. The card with every role, zone and rule is ${team.dir}/CARD.md; the ledger is ${team.dir}/tasks.json.`,
        context: 'fresh',
        use_worktree: false,
        name: r.name.replace(/[^a-z0-9-]/g, '').slice(0, 24) || undefined,
      } as never).catch(err => ({ deny: String(err) }))
      const id = 'text' in ran ? ran.text?.match(/local_[0-9a-f-]{8,}/)?.[0] : undefined
      if (id) {
        r.sessionId = id
        notes.push(`${r.name}: session ${id}`)
      } else {
        notes.push(`${r.name}: not started (${'deny' in ran ? ran.deny : 'no session id in the answer'})`)
      }
    } else {
      const spawned = await $.agent.spawn({ prompt: text, name: r.name, description: r.lane }).catch(err => ({ deny: String(err) }))
      if ('agentId' in spawned && spawned.agentId) {
        r.agentId = spawned.agentId
        notes.push(`${r.name}: subagent ${spawned.agentId}`)
      } else {
        notes.push(`${r.name}: not started (${'deny' in spawned ? spawned.deny : 'no agent id'})`)
      }
    }
  }
  await writeTeam($, team)
  return notes
}

// ---- Tools ------------------------------------------------------------------

const TOOLS = [
  {
    name: 'team_create',
    description: 'Create a team for one task: lays its folder out (card, ledger, notes, inboxes), asks the person once, then starts one session per role (Claude Desktop) or one subagent per role. This session becomes the lead. Draft roles with /team <task> first.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The task in one or two sentences' },
        slug: { type: 'string', description: 'Folder name, [a-z0-9-]; derived from the goal when absent' },
        roles: {
          type: 'array',
          description: '2-6 roles; no "lead" role (this session is the lead)',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short handle, [a-z0-9-]' },
              lane: { type: 'string', description: 'What the role does and owns, one line' },
              zone: { type: 'array', items: { type: 'string' }, description: 'Path prefixes (relative to the project root) the role may edit; empty = read-only' },
              deliverable: { type: 'string', description: 'What done looks like' },
              verifier: { type: 'string', description: 'The role that verifies its results; absent = nobody' },
            },
            required: ['name', 'lane', 'zone', 'deliverable'],
          },
        },
        tasks: {
          type: 'array',
          description: 'The first tasks, in order; each owner a role name',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              owner: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'string' }, description: 'Ids T-0001.. of earlier tasks in this list' },
              verifier: { type: 'string' },
            },
            required: ['title', 'owner'],
          },
        },
        rules: { type: 'array', items: { type: 'string' }, description: 'Extra rules for this team, beside the six every team keeps' },
      },
      required: ['goal', 'roles'],
    },
  },
  {
    name: 'team_join',
    description: 'Declare this session a member of a team, as a role (used when the brief says the plugin did not recognise the session).',
    inputSchema: { type: 'object', properties: { team: { type: 'string' }, role: { type: 'string' } }, required: ['team', 'role'] },
  },
  {
    name: 'team_task',
    description: 'The team ledger: add a task, set its status (in_progress, awaiting_verify, done, failed, dropped; blocked and ready follow from depends_on), list tasks, or draw the board. A done task wakes every task that waited on it; awaiting_verify wakes the verifier.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'set', 'list', 'board'] },
        id: { type: 'string', description: 'set: the task id' },
        title: { type: 'string', description: 'add: the task' },
        owner: { type: 'string', description: 'add: the role; set: a new owner' },
        depends_on: { type: 'array', items: { type: 'string' } },
        verifier: { type: 'string' },
        status: { type: 'string', enum: ['in_progress', 'awaiting_verify', 'done', 'failed', 'dropped'] },
        note: { type: 'string' },
        artifact: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string' } }, required: ['path'] },
        force: { type: 'boolean', description: 'set done although a dependency is open' },
      },
      required: ['action'],
    },
  },
  {
    name: 'team_notify',
    description: 'Send a role of the team a message: an event file in its inbox, and the message to its session when it has one. "lead" addresses the lead.',
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string' }, text: { type: 'string' }, path: { type: 'string', description: 'An artifact the message is about' } },
      required: ['role', 'text'],
    },
  },
  {
    name: 'team_handoff',
    description: 'Write the queue block of your handoff note: the next items in order, what runs (pid or unit), what waits on whom. The plugin adds the stamp, your session id and the context reading.',
    inputSchema: {
      type: 'object',
      properties: { queue: { type: 'string', description: 'The block, markdown' }, state: { type: 'string', description: 'One line: nothing running / X running (pid) / waiting on <role> for <what>' } },
      required: ['queue'],
    },
  },
  {
    name: 'team_status',
    description: 'The team board: every open task by owner, each role with its last turn and context reading.',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function teamOf($: EngineInterface): Promise<{ me: Membership } | { text: string }> {
  const m = await who($)
  return m ? { me: m } : { text: 'This session is in no team. /team <task> drafts one; mcp__rp__team_join joins one.' }
}

async function createTeam($: EngineInterface, input: Input): Promise<string> {
  const goal = str(input.goal).trim()
  const rolesIn = Array.isArray(input.roles) ? (input.roles as Input[]) : []
  if (!goal || rolesIn.length < 1) return 'team_create needs a goal and at least one role.'
  const roles: Role[] = rolesIn.map(r => ({
    name: slugify(str(r.name)),
    lane: str(r.lane),
    zone: strs(r.zone),
    deliverable: str(r.deliverable),
    verifier: str(r.verifier) || null,
    active: true,
  }))
  const names = new Set(roles.map(r => r.name))
  if (names.size !== roles.length || names.has('lead')) return 'Role names must be unique and none may be "lead".'
  for (const r of roles) if (r.verifier && !names.has(r.verifier)) return `Verifier "${r.verifier}" of ${r.name} is not a role.`
  const slug = slugify(str(input.slug) || goal)
  const base = await teamsDir($)
  const dir = `${base}/${slug}`
  if (await $.fs.exists(dir)) return `A team folder ${dir} exists already; choose another slug or close that team.`
  const at = await stamp($)
  const team: Team = {
    slug, goal, dir, root: await $.session.root(), lead: await $.session.id(), roles,
    rules: [...RULES, ...strs(input.rules)], created: at,
  }
  let ledger: Ledger = { next: 1, tasks: [] }
  for (const t of Array.isArray(input.tasks) ? (input.tasks as Input[]) : []) {
    const owner = slugify(str(t.owner))
    if (!names.has(owner)) return `Task "${str(t.title)}" names an owner that is not a role: ${owner}.`
    ledger = addTask(ledger, { title: str(t.title), owner, depends_on: strs(t.depends_on), verifier: str(t.verifier) || null }, at, 'lead').ledger
  }
  const question = `Start the team "${slug}" (${roles.length} roles: ${roles.map(r => r.name).join(', ')}) for: ${goal}?`
  const choice = await $.ui.ask(question, ['Start', 'Not now']).catch(() => 'Not now')
  if (choice !== 'Start') return `Not started. The draft:\n\n${cardText(team)}`
  await layOut($, team)
  await writeLedger($, dir, ledger)
  const started = await startMembers($, team, ledger)
  me = { team, role: 'lead' }
  meAt = await $.clock.now()
  armPoll($, team)
  await refreshView($, team)
  void $.ui.open({ id: PANE, title: `Team ${slug}` })
  return [`Team ${slug} created at ${dir}. You are the lead.`, ...started, '', board(ledger, at)].join('\n')
}

async function taskTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  const { team } = m
  const by = m.role
  const at = await stamp($)
  const ledger = await readLedger($, team.dir)
  const action = str(input.action)
  if (action === 'board') return board(ledger, at)
  if (action === 'list') {
    const owner = str(input.owner)
    const rows = ledger.tasks.filter(t => !owner || t.owner === owner)
    return rows.length ? rows.map(t => `${t.id} ${t.status} ${t.owner}: ${t.title}${t.depends_on.length ? ` (after ${t.depends_on.join(', ')})` : ''}`).join('\n') : 'No tasks.'
  }
  if (action === 'add') {
    const owner = str(input.owner) || by
    if (owner !== 'lead' && !team.roles.some(r => r.name === owner)) return `No role "${owner}" in this team.`
    const added = addTask(ledger, { title: str(input.title), owner, depends_on: strs(input.depends_on), verifier: str(input.verifier) || null, note: str(input.note) || undefined }, at, by)
    await writeLedger($, team.dir, added.ledger)
    const woke = added.task.status === 'ready' && owner !== by ? await wake($, team, by, [{ role: owner, kind: 'ready', task: added.task.id, text: `${added.task.id} is ready: ${added.task.title}` }]) : []
    return [`${added.task.id} ${added.task.status}: ${added.task.title}`, ...woke].join('\n')
  }
  if (action === 'set') {
    const id = str(input.id)
    const status = str(input.status) || undefined
    const before = ledger.tasks.find(t => t.id === id)
    if (before && status === 'done' && before.verifier && by !== before.verifier && by !== 'lead')
      return `${id} has a verifier (${before.verifier}): send it with status awaiting_verify; only the verifier or the lead marks it done.`
    const args: SetArgs = {
      id, status: status as Status | undefined, note: str(input.note) || undefined,
      artifact: input.artifact && typeof input.artifact === 'object' ? (input.artifact as { path: string; sha256?: string }) : undefined,
      depends_on: Array.isArray(input.depends_on) ? strs(input.depends_on) : undefined,
      verifier: typeof input.verifier === 'string' ? input.verifier || null : undefined,
      owner: str(input.owner) || undefined, force: input.force === true,
    }
    const set = setTask(ledger, args, at, by)
    if ('error' in set) return set.error
    await writeLedger($, team.dir, set.ledger)
    const woke = await wake($, team, by, set.wakes)
    if (m.role === 'lead') await refreshView($, team)
    return [`${set.task.id} ${set.task.status}: ${set.task.title}`, ...woke].join('\n')
  }
  return 'action must be add, set, list or board.'
}

async function handoffTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  const { team, role } = m
  const path = noteFile(team.dir, role)
  const note = await $.fs.read(path).catch(() => `# ${role} -- handoff\n\n## Inbox\n`)
  const usage = await $.session.usage().catch(() => undefined)
  const context = usage?.context.percent
  const heading = [await stamp($), str(input.state) || 'state not given', `session ${await $.session.id()}`, context !== undefined ? `context ${context} %` : undefined].filter(Boolean).join('; ')
  await $.fs.write(path, replaceQueue(note, heading, str(input.queue)))
  return `Queue block written to ${path} (${heading}).`
}

async function statusText($: EngineInterface, m: Membership): Promise<string> {
  const { team } = m
  const ledger = await readLedger($, team.dir)
  const lines = [board(ledger, await stamp($)), '', '## Roles']
  for (const r of team.roles) {
    const s = await $.fs.read(stateFile(team.dir, r.name)).then(t => JSON.parse(t) as { at?: string; context?: number; answer?: string }).catch(() => ({}))
    const where = r.sessionId ? `session ${r.sessionId}` : r.agentId ? `agent ${r.agentId}` : 'not started'
    lines.push(`- ${r.name}: ${where}${r.active ? '' : ', parked'}${s.at ? `; last turn ${s.at}` : ''}${s.context !== undefined ? `; context ${s.context} %` : ''}${s.answer ? `; said: ${s.answer}` : ''}`)
  }
  const unread = await unreadEvents($, team.dir, 'lead')
  if (unread.length) lines.push('', `## Unread events for the lead: ${unread.length}`, ...unread.map(e => `- ${e.name}`))
  return lines.join('\n')
}

// ---- The zone guard ---------------------------------------------------------

async function placed($: EngineInterface, path: string): Promise<string | undefined> {
  const abs = path.startsWith('/') ? path : `${await $.session.cwd()}/${path}`
  const own = await $.fs.stat(abs, { resolve: true }).catch(() => undefined)
  if (own?.realPath) return own.realPath
  const cut = abs.lastIndexOf('/')
  const dir = await $.fs.stat(abs.slice(0, cut + 1), { resolve: true }).catch(() => undefined)
  return dir?.realPath === undefined ? undefined : `${dir.realPath.replace(/\/$/, '')}/${abs.slice(cut + 1)}`
}

async function outsideZone($: EngineInterface, path: string): Promise<string | undefined> {
  const m = await who($)
  if (!m || m.role === 'lead') return undefined
  const role = m.team.roles.find(r => r.name === m.role)
  if (!role) return undefined
  const real = await placed($, path)
  if (real === undefined) return `${$.plugin.name}: cannot place ${path}; a member edits only inside its zone`
  const root = m.team.root.replace(/\/$/, '')
  const allowed = [m.team.dir, ...role.zone.map(z => `${root}/${z.replace(/^\.?\//, '').replace(/\/$/, '')}`)]
  const inside = allowed.some(a => real === a || real.startsWith(`${a}/`))
  return inside ? undefined : `${$.plugin.name}: ${path} is outside the zone of the role "${role.name}" (${role.zone.join(', ') || 'none'}); ask the owner of that path, or the lead.`
}

// ---- Commands ---------------------------------------------------------------

async function teamCommand($: EngineInterface, argsText: string): Promise<{ text: string; context?: string[] }> {
  const args = (argsText ?? '').trim()
  const word = args.split(/\s+/)[0] ?? ''
  if (word === 'status' || args === '') {
    const got = await teamOf($)
    if ('text' in got) {
      const teams = await listTeams($)
      return { text: teams.length ? `${got.text}\nTeams here: ${teams.map(t => `${t.slug}${t.closed ? ' (closed)' : ''}`).join(', ')}` : got.text }
    }
    if (got.me.role === 'lead') {
      await refreshView($, got.me.team)
      void $.ui.open({ id: PANE, title: `Team ${got.me.team.slug}` })
    }
    return { text: await statusText($, got.me) }
  }
  if (word === 'close') {
    const got = await teamOf($)
    if ('text' in got) return { text: got.text }
    const team = (await readTeam($, got.me.team.dir)) ?? got.me.team
    team.closed = await stamp($)
    await writeTeam($, team)
    poll?.cancel()
    poll = undefined
    me = undefined
    return {
      text: `Team ${team.slug} closed at ${team.closed}; its folder stays at ${team.dir}.`,
      context: ['Write the final report in the schema: what was done · worked or not · what is needed next, from the ledger and the handoff notes. Ask the person before archiving the role sessions.'],
    }
  }
  return {
    text: `Team draft requested for: ${args}`,
    context: [
      [
        `Design a team for this task: "${args}".`,
        'Draft 2-6 roles, each with a name ([a-z0-9-]), a one-line lane, a zone (path prefixes it may edit; empty when read-only), what done looks like, and a verifier where a result must be checked by someone else (the one who does never judges). This session is the lead and is not a role.',
        'Then the first tasks in order, each with its owner and what it waits on. Keep the team as small as the task allows.',
        'Show the draft to the person in at most two variants with a recommendation, then call mcp__rp__team_create with the chosen one; the tool asks the person once more before starting anything.',
      ].join('\n'),
    ],
  }
}

// ---- Registration -------------------------------------------------------------

// A member reads its card and queue in the system prompt; the lead its
// board. One section, or nothing outside a team; hooks/register.ts adds it
// in the plugin's one prompt.compose hook.
export async function teamSection($: EngineInterface): Promise<PromptComposeSection | undefined> {
  const m = await who($)
  if (!m) return undefined
  let text: string
  if (m.role === 'lead') {
    text = leadSection(m.team, board(await readLedger($, m.team.dir), 'now'))
  } else {
    const note = await $.fs.read(noteFile(m.team.dir, m.role)).catch(() => '')
    const role = m.team.roles.find(r => r.name === m.role)
    if (!role) return undefined
    text = memberSection(m.team, role, queueBlock(note))
  }
  return { id: `${$.plugin.name}:team`, text, scope: 'session' }
}

// Called from the plugin's one session.start hook (hooks/register.ts).
export async function startTeam($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'team', description: 'A team of sessions for one task: /team <task> drafts it, "status" draws the board, "close" ends it', argumentHint: '<task> | status | close' })
  for (const tool of TOOLS) await $.tool.register(tool)
  me = undefined
  meAt = 0
  poll?.cancel()
  poll = undefined
  const m = await who($)
  if (m?.role === 'lead') {
    armPoll($, m.team)
    await refreshView($, m.team)
  }
}

export function registerTeam(on: On): void {
  on('command.run', { command: 'team' }, ($, e) => teamCommand($, e.args))
  on('command.run', { command: 'rp:team' }, ($, e) => teamCommand($, e.args))

  on('tool.call', { tool: 'mcp__rp__team_create' }, async ($, e) => answer(await createTeam($, e as unknown as Input)))

  on('tool.call', { tool: 'mcp__rp__team_join' }, async ($, e) => {
    const input = e as unknown as Input
    const slug = slugify(str(input.team))
    const role = slugify(str(input.role))
    const team = (await listTeams($)).find(t => t.slug === slug && !t.closed)
    if (!team) return answer(`No open team "${slug}" here.`)
    const r = team.roles.find(x => x.name === role)
    if (!r) return answer(`No role "${role}" in team ${slug}.`)
    r.sessionId = await $.session.id()
    await writeTeam($, team)
    me = { team, role }
    meAt = await $.clock.now()
    return answer(`Joined team ${slug} as ${role}. Card: ${team.dir}/CARD.md`)
  })

  on('tool.call', { tool: 'mcp__rp__team_task' }, async ($, e) => {
    const got = await teamOf($)
    return answer('text' in got ? got.text : await taskTool($, got.me, e as unknown as Input))
  })

  on('tool.call', { tool: 'mcp__rp__team_notify' }, async ($, e) => {
    const got = await teamOf($)
    if ('text' in got) return answer(got.text)
    const input = e as unknown as Input
    const role = str(input.role) === 'lead' ? 'lead' : slugify(str(input.role))
    if (role !== 'lead' && !got.me.team.roles.some(r => r.name === role)) return answer(`No role "${role}" in this team.`)
    return answer(await notify($, got.me.team, role, got.me.role, str(input.text), str(input.path) || undefined))
  })

  on('tool.call', { tool: 'mcp__rp__team_handoff' }, async ($, e) => {
    const got = await teamOf($)
    return answer('text' in got ? got.text : await handoffTool($, got.me, e as unknown as Input))
  })

  on('tool.call', { tool: 'mcp__rp__team_status' }, async $ => {
    const got = await teamOf($)
    return answer('text' in got ? got.text : await statusText($, got.me), true)
  })

  // A member edits only inside its zone and the team folder.
  for (const tool of ['Edit', 'Write', 'MultiEdit'] as const) {
    on('tool.call', { tool }, async ($, e, next) => {
      const why = await outsideZone($, (e as unknown as { file_path: string }).file_path)
      return why ? { deny: why } : next(e)
    }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: the zone guard failed.` }))
  }
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const why = await outsideZone($, (e as unknown as { notebook_path: string }).notebook_path)
    return why ? { deny: why } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: the zone guard failed.` }))

  // A delivery survives in the note, whatever the session does with it.
  on('session.receive', async ($, e, next) => {
    const m = await who($)
    if (m && e.agentId === undefined) {
      const from = 'plugin' in e.origin && e.origin.plugin ? `${e.origin.kind} via ${e.origin.plugin}` : e.origin.kind
      await appendInbox($, m.team.dir, m.role, `${await stamp($)} received (${from}): ${e.text.replace(/\s+/g, ' ').slice(0, 160)}`).catch(() => undefined)
    }
    return next(e)
  })

  // Each main-loop turn leaves the member's state for the lead's board.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done
    const m = await who($)
    if (!m) return done
    const usage = await $.session.usage().catch(() => undefined)
    await $.fs.write(stateFile(m.team.dir, m.role), JSON.stringify({
      at: await stamp($), reason: e.reason, context: usage?.context.percent, answer: e.answer.replace(/\s+/g, ' ').slice(0, 200),
    }, null, 2) + '\n').catch(() => undefined)
    if (m.role === 'lead') await refreshView($, m.team).catch(() => undefined)
    return done
  })

  on('session.end', async ($, e, next) => {
    const m = await who($)
    if (m) await appendInbox($, m.team.dir, m.role, `${await stamp($)} session ended (${e.reason}), id ${e.sessionId}`).catch(() => undefined)
    poll?.cancel()
    poll = undefined
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = await read($, view)
    if (!v) return <Text dimColor>{'No team in this session. /team <task> drafts one.'}</Text>
    const cols = Math.max(30, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        <Text bold wrap="truncate">{`${v.slug}: ${v.goal}`.slice(0, cols)}</Text>
        {v.roles.map(r => (
          <Text key={`role-${r.name}`} wrap="truncate">
            <Text color={r.isStarted ? (r.isActive ? 'success' : 'warning') : 'error'}>{r.isStarted ? (r.isActive ? '●' : '◐') : '○'}</Text>
            <Text> {r.name}</Text>
            <Text dimColor>{r.context !== undefined ? `  ctx ${r.context}%` : ''}{r.lastAt ? `  ${r.lastAt}` : ''}</Text>
          </Text>
        ))}
        <Text> </Text>
        {v.board.split('\n').slice(1).map((line, i) => (
          <Text key={`board-${i}`} wrap="truncate" dimColor={line.startsWith('_')} bold={line.startsWith('## ')}>
            {line.replace(/^## /, '').replace(/\*\*/g, '')}
          </Text>
        ))}
      </Box>
    )
  })
}

export const _internal = { inboxDir }
