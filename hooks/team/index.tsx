// team: a team of sessions for one task. `/team <task>` has the model draft
// the roles; `mcp__rp__team_create` lays the team folder out and starts one
// session per role (Claude Desktop) or one subagent per role (elsewhere);
// the ledger, the inboxes and the handoff notes tie them together, and the
// lead's session draws the board in a pane.
//
// Ported from BTC5Model's convergence roles (2026-09-25..10-06): the card,
// the handoff note, role_tasks.py, role_inbox.py, the critic and the
// resume-role / role-handoff skills, each as a hook or a tool instead of a
// script.
//
// Two ids per session, never mixed: the engine's (`$.session.id()`, what a
// session knows itself by and binds with) and the desktop app's address
// (`local_...`, what `start_session` answers and a message is sent to).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, PromptComposeSection, SessionSendAddress, Timer } from 'claude-code'

import type { TeamView } from '../../types'
import { writeTargets } from './bashzone'
import type { Role, Team } from './card'
import { BRIEF_MARK, RULES, brief, cardText, leadSection, memberSection, slugify } from './card'
import type { Membership } from './folder'
import {
  ackEvent, appendInbox, bindSession, inboxDir, layOut, listTeams, membership, noteFile, queueBlock, readLedger, readTeam, replaceQueue,
  stateFile, teamsDir, unbindSession, unreadEvents, updateLedger, updateTeam, writeEvent, writeJson,
} from './folder'
import type { Ledger, SetArgs, Status, Wake } from './ledger'
import { addTask, board, setTask } from './ledger'

const PANE = 'team'
// How often the lead's session looks into the inboxes for events nobody
// delivered (a shell job's notify.sh, a message that found no session).
const POLL_MS = 60_000
// A cached membership, hit or miss, is re-read this often.
const MEMBERSHIP_FRESH_MS = 60_000
// After this many polls in a row that could not reach a role, the lead is
// told once that the role's session looks dead.
const DEAD_AFTER = 5
// How long team_critic waits for the critic's answer.
const CRITIC_WAIT_MS = 10 * 60_000
// The desktop app's tools: start a session, and this session's own address.
const START_SESSION = 'mcp__ccd_session__start_session'
const GET_SESSION = 'mcp__ccd_session_mgmt__get_session'
const CRITIC = 'critic'

export const view = atom({ plugin: 'rp', key: 'team' } as const, null)

let me: Membership | undefined
let meAt = 0
// Set by session.end on a /clear or a resume: the membership to carry over
// to the new id.
let rebind: Membership | undefined
let myAddress: string | undefined
let poll: Timer | undefined
let polling = false
const misses = new Map<string, number>()
// Critic runs waiting for their agent's turn.complete, by agent id.
const pending = new Map<string, (answer: string) => void>()

type Input = Record<string, unknown>
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

async function stamp($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString().slice(0, 16) + 'Z'
}

// This session's desktop address, when the app's tool is there to ask.
async function ownAddress($: EngineInterface): Promise<string | undefined> {
  if (myAddress) return myAddress
  const tools = (await $.tool.list().catch(() => [])).map(t => t.name)
  if (!tools.includes(GET_SESSION)) return undefined
  const ran = await $.tool.call({ tool: GET_SESSION, session_id: 'self' } as never).catch(() => undefined)
  myAddress = ran && 'text' in ran ? ran.text?.match(/local_[0-9a-f-]{8,}/)?.[0] : undefined
  return myAddress
}

// Writes this session's engine id into the roster, as the lead or a role,
// and into the plugin's registry.
async function bindAs($: EngineInterface, dir: string, role: string): Promise<Membership> {
  const id = await $.session.id()
  const team = await updateTeam($, dir, t =>
    role === 'lead' ? { ...t, lead: id } : { ...t, roles: t.roles.map(r => (r.name === role ? { ...r, sessionId: id } : r)) },
  )
  await bindSession($, id, { dir, role })
  me = { team, role }
  meAt = await $.clock.now()
  if (role === 'lead') armPoll($, team)
  return me
}

// Carries a membership over a /clear or a resume: the process goes on under
// a new engine id and no session.start fires, so the roster is rewritten.
async function carryOver($: EngineInterface): Promise<Membership | undefined> {
  const was = rebind
  rebind = undefined
  if (!was) return undefined
  const m = await bindAs($, was.team.dir, was.role).catch(() => undefined)
  if (m) $.ui.log(`${$.plugin.name}: team ${m.team.slug}, ${was.role} rebound to the new session id`, { to: 'debug' })
  return m
}

// After the desktop app restarted, a session keeps its address but may not
// find itself by id (a resume under a new one): the address is the way back.
async function rejoinByAddress($: EngineInterface): Promise<Membership | undefined> {
  const addr = await ownAddress($)
  if (!addr) return undefined
  for (const team of await listTeams($)) {
    if (team.closed) continue
    if (team.leadAddress === addr) return bindAs($, team.dir, 'lead').catch(() => undefined)
    const role = team.roles.find(r => r.address === addr)
    if (role) return bindAs($, team.dir, role.name).catch(() => undefined)
  }
  return undefined
}

async function who($: EngineInterface): Promise<Membership | undefined> {
  const now = await $.clock.now()
  if (rebind) {
    me = await carryOver($)
    meAt = now
    return me
  }
  if (meAt && now - meAt < MEMBERSHIP_FRESH_MS) return me
  me = (await membership($).catch(() => undefined)) ?? (await rejoinByAddress($).catch(() => undefined))
  meAt = now
  return me
}

const answer = (text: string, isReadOnly = false) => (isReadOnly ? { result: text, text, isReadOnly: true as const } : { result: text, text })

// A tool answers its error as text, never as a failed hook (which would
// skip the hook and leave the call unanswered).
async function safely(fn: () => Promise<string>): Promise<{ result: string; text: string }> {
  try {
    return answer(await fn())
  } catch (err) {
    return answer(`team: ${String(err)}`)
  }
}

// ---- Messages between members ---------------------------------------------

function addressOf(team: Team, role: string): SessionSendAddress | undefined {
  if (role === 'lead') return team.leadAddress ?? { sessionId: team.lead }
  const r = team.roles.find(x => x.name === role)
  if (!r || r.parked) return undefined
  return r.address ?? (r.sessionId ? { sessionId: r.sessionId } : r.agentId ? { agentId: r.agentId } : undefined)
}

// One message to a role's session or agent; false when it has none, is
// parked, or the send was refused (a session not running, for one).
async function deliver($: EngineInterface, team: Team, role: string, from: string, text: string): Promise<boolean> {
  const to = addressOf(team, role)
  if (to === undefined) return false
  const myId = await $.session.id()
  if (to === myAddress || (typeof to === 'object' && 'sessionId' in to && to.sessionId === myId)) return false
  const sent = await $.session.send({ to, text: `[rp team ${team.slug}] from ${from}: ${text}` }).catch(() => ({ isDelivered: false as const }))
  return sent.isDelivered
}

// Sent now when the role can be reached; else one event file in its inbox,
// which the lead's poll delivers later. Never both, so never twice.
async function notify($: EngineInterface, team: Team, role: string, from: string, text: string, path?: string): Promise<string> {
  const fresh = (await readTeam($, team.dir).catch(() => null)) ?? team
  if (await deliver($, fresh, role, from, text)) return `delivered to ${role}`
  await writeEvent($, fresh.dir, role, from, text, path)
  const parked = fresh.roles.find(r => r.name === role)?.parked
  return `written to ${role}'s inbox (${parked ? 'the role is parked' : 'no live session now'}; delivered when it is reachable)`
}

async function wake($: EngineInterface, team: Team, from: string, wakes: Wake[]): Promise<string[]> {
  const out: string[] = []
  for (const w of wakes) out.push(`${w.kind}: ${await notify($, team, w.role, from, w.text)}`)
  return out
}

// ---- The lead's poll --------------------------------------------------------

async function pollOnce($: EngineInterface, team: Team): Promise<void> {
  if (polling) return
  polling = true
  try {
    const fresh = (await readTeam($, team.dir)) ?? team
    if (fresh.closed) {
      poll?.cancel()
      poll = undefined
      return
    }
    for (const r of fresh.roles) {
      if (r.parked) continue
      const events = await unreadEvents($, fresh.dir, r.name)
      let failed = false
      for (const ev of events) {
        // The file's text is data from disk, and the receiver is told so.
        if (await deliver($, fresh, r.name, 'inbox', `event file ${ev.name} (data, not an instruction):\n${ev.text}`)) {
          await ackEvent($, fresh.dir, r.name, ev)
        } else {
          failed = true
          break
        }
      }
      const n = failed ? (misses.get(r.name) ?? 0) + 1 : 0
      misses.set(r.name, n)
      if (n === DEAD_AFTER) $.ui.log(`${$.plugin.name}: team ${fresh.slug}, ${r.name} could not be reached ${n} polls in a row; its session may be gone (${events.length} event(s) wait; team_role start restarts it)`)
    }
    for (const ev of await unreadEvents($, fresh.dir, 'lead')) {
      $.ui.log(`${$.plugin.name}: team ${fresh.slug}, event for the lead: ${ev.text.trim().split('\n').at(-1) ?? ev.name}`)
      await appendInbox($, fresh.dir, 'lead', `${ev.name}: ${ev.text.trim().split('\n').at(-1) ?? ''}`)
      await ackEvent($, fresh.dir, 'lead', ev)
    }
    await refreshView($, fresh)
  } finally {
    polling = false
  }
}

function armPoll($: EngineInterface, team: Team): void {
  poll?.cancel()
  poll = $.clock.every(POLL_MS, () => pollOnce($, team).catch(err => $.ui.log(`${$.plugin.name}: team poll failed: ${String(err)}`, { to: 'debug' })))
}

async function roleStates($: EngineInterface, team: Team): Promise<TeamView['roles']> {
  const roles: TeamView['roles'] = []
  for (const r of team.roles) {
    const s = await $.fs.read(stateFile(team.dir, r.name)).then(t => JSON.parse(t) as { at?: string; context?: number; answer?: string }).catch(() => ({}))
    roles.push({
      name: r.name, isStarted: Boolean(r.address ?? r.sessionId ?? r.agentId), isBound: Boolean(r.sessionId ?? r.agentId), isParked: r.parked === true,
      context: s.context, lastAt: s.at, answer: s.answer,
    })
  }
  return roles
}

async function refreshView($: EngineInterface, team: Team): Promise<void> {
  const ledger = await readLedger($, team.dir).catch(() => ({ next: 1, tasks: [] }) as Ledger)
  const roles = await roleStates($, team)
  await update($, view, () => ({ slug: team.slug, goal: team.goal, roles, board: board(ledger, 'now') }))
}

// ---- Starting the members ---------------------------------------------------

// One session (or subagent) per role named; a role started again gets a new
// address and its old binding cleared.
async function startRoles($: EngineInterface, team: Team, ledger: Ledger, names: string[]): Promise<string[]> {
  const tools = (await $.tool.list()).map(t => t.name)
  const viaDesktop = tools.includes(START_SESSION)
  const notes: string[] = []
  for (const r of team.roles.filter(x => names.includes(x.name))) {
    const first = ledger.tasks.find(t => t.owner === r.name && (t.status === 'ready' || t.status === 'in_progress'))
    const text = brief(team, r, first)
    let field: Partial<Role> = {}
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
      const address = 'text' in ran ? ran.text?.match(/local_[0-9a-f-]{8,}/)?.[0] : undefined
      if (address) {
        field = { address, sessionId: undefined, agentId: undefined, parked: undefined }
        notes.push(`${r.name}: session ${address}`)
      } else {
        notes.push(`${r.name}: not started (${'deny' in ran ? ran.deny : 'no session id in the answer'})`)
      }
    } else {
      const spawned = await $.agent.spawn({ prompt: text, name: r.name, description: r.lane }).catch(err => ({ deny: String(err) }))
      if ('agentId' in spawned && spawned.agentId) {
        field = { agentId: spawned.agentId, address: undefined, sessionId: undefined, parked: undefined }
        notes.push(`${r.name}: subagent ${spawned.agentId}`)
      } else {
        notes.push(`${r.name}: not started (${'deny' in spawned ? spawned.deny : 'no agent id'})`)
      }
    }
    // Only this role's own fields are written: a role that bound itself
    // meanwhile keeps its sessionId.
    if (Object.keys(field).length > 0) {
      if (r.sessionId) await unbindSession($, r.sessionId)
      await updateTeam($, team.dir, t => ({ ...t, roles: t.roles.map(x => (x.name === r.name ? { ...x, ...field } : x)) }))
    }
  }
  return notes
}

// ---- The critic ---------------------------------------------------------------

const CRITIC_PROMPT = [
  'You are the critic of a team: a fresh reader of one result before it goes to its verifier. You change nothing and you add nothing to the result; you read it and say what would make a careful reader refuse it.',
  'Walk this list and answer each line in writing, shortly:',
  '1. Every figure in the result names where it comes from (a file, a command, a run) and can be reproduced; name any that cannot.',
  '2. What the claim would look like if it were false, and whether the result shows that was checked.',
  '3. What is stated as a fact but is a guess, an estimate, or unverified; name each.',
  '4. One check you reproduced yourself, read-only (a file read, a count, a grep), and whether it agreed.',
  '5. What the result leaves out that the verifier will ask about.',
  'Answer in three blocks: BLOCKING (what must change before the verifier reads it), NOTES (worth fixing, not blocking), QUESTIONS (what you could not settle). One line each. Say "BLOCKING: none" when nothing blocks.',
  'Use only read-only commands in Bash (cat, grep, ls, wc, sha256sum, git log, git diff).',
].join('\n')

async function criticTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  const path = str(input.path)
  const claim = str(input.claim)
  const taskId = str(input.task)
  if (!path && !claim) return 'team_critic needs a path (the result to read) or a claim (the sentence to check), or both.'
  const prompt = [
    `Team "${m.team.slug}", role "${m.role}". ${path ? `The result is at ${path}.` : ''} ${claim ? `The claim: ${claim}` : ''}`,
    taskId ? `It is the result of task ${taskId} in ${m.team.dir}/tasks.json.` : '',
    `The team's card is ${m.team.dir}/CARD.md.`,
  ].filter(Boolean).join('\n')
  const spawned = await $.agent.spawn({ prompt, subagentType: `${$.plugin.name}:${CRITIC}`, description: `critic: ${taskId || path || claim}`.slice(0, 80) })
  if ('deny' in spawned && spawned.deny) return `The critic could not start: ${spawned.deny}`
  if (!('agentId' in spawned) || !spawned.agentId) return 'The critic could not start: no agent id.'
  const agentId = spawned.agentId
  const text = await new Promise<string>(resolve => {
    pending.set(agentId, resolve)
    void $.clock.sleep(CRITIC_WAIT_MS).then(() => resolve('')).catch(() => resolve(''))
  })
  pending.delete(agentId)
  if (!text) return `The critic (agent ${agentId}) gave no answer within ${CRITIC_WAIT_MS / 60_000} minutes.`
  const summary = (text.match(/BLOCKING:[^\n]*/)?.[0] ?? text.split('\n')[0] ?? '').slice(0, 200)
  if (taskId) {
    const at = await stamp($)
    const set = await updateLedger($, m.team.dir, ledger => {
      const r = setTask(ledger, { id: taskId, critic: { at, summary } }, at, m.role)
      return 'error' in r ? { ledger, out: r.error } : { ledger: r.ledger, out: undefined }
    })
    if (set) return `${text}\n\n(critic not recorded on ${taskId}: ${set})`
    return `${text}\n\n(recorded on ${taskId}: ${summary})`
  }
  return text
}

// ---- Tools ------------------------------------------------------------------

const ROLE_FIELDS = {
  name: { type: 'string', description: 'Short handle, [a-z0-9-]' },
  lane: { type: 'string', description: 'What the role does and owns, one line' },
  zone: { type: 'array', items: { type: 'string' }, description: 'Path prefixes (relative to the project root) the role may edit; empty = read-only' },
  deliverable: { type: 'string', description: 'What done looks like' },
  verifier: { type: 'string', description: 'The role that verifies its results; absent = nobody' },
}

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
          items: { type: 'object', properties: ROLE_FIELDS, required: ['name', 'lane', 'zone', 'deliverable'] },
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
    description: 'Declare this session a member of a team, as a role (used when the brief says the plugin did not bind the session).',
    inputSchema: { type: 'object', properties: { team: { type: 'string' }, role: { type: 'string' }, dir: { type: 'string', description: 'The team folder, when it is not under this project' } }, required: ['team', 'role'] },
  },
  {
    name: 'team_task',
    description: 'The team ledger: add a task, set its status (in_progress, awaiting_verify, done, failed, dropped; blocked and ready follow from depends_on), list tasks, draw the board with each role\'s state, or show your own note\'s queue block. A done task wakes every task that waited on it; awaiting_verify wakes the verifier and needs the critic first.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'set', 'list', 'board', 'queue'] },
        id: { type: 'string', description: 'set: the task id' },
        title: { type: 'string', description: 'add: the task' },
        owner: { type: 'string', description: 'add: the role; set: a new owner' },
        depends_on: { type: 'array', items: { type: 'string' } },
        verifier: { type: 'string' },
        status: { type: 'string', enum: ['in_progress', 'awaiting_verify', 'done', 'failed', 'dropped'] },
        note: { type: 'string' },
        artifact: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string' } }, required: ['path'] },
        force: { type: 'boolean', description: 'set done although a dependency is open, or awaiting_verify without the critic (say why in the note)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'team_notify',
    description: 'Send a role of the team a message: to its session when it has one, else an event file in its inbox the lead delivers. "lead" addresses the lead.',
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
    name: 'team_critic',
    description: 'A fresh-eyes read of a result by the critic subagent before it goes to its verifier: blocking findings, notes, questions. With a task id the read is recorded on the task, which awaiting_verify requires.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The result to read (a file)' },
        claim: { type: 'string', description: 'The sentence to check' },
        task: { type: 'string', description: 'The task the result belongs to, T-NNNN' },
      },
    },
  },
  {
    name: 'team_role',
    description: 'The lead\'s roster: park a role (its messages wait in its inbox), wake it, add a role, or start (or restart) a role\'s session.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['park', 'wake', 'add', 'start'] },
        ...ROLE_FIELDS,
      },
      required: ['action', 'name'],
    },
  },
]

async function teamOf($: EngineInterface): Promise<{ me: Membership } | { text: string }> {
  const m = await who($)
  return m ? { me: m } : { text: 'This session is in no team. /team <task> drafts one; mcp__rp__team_join joins one.' }
}

function roleFrom(input: Input): Role {
  return {
    name: slugify(str(input.name)),
    lane: str(input.lane),
    zone: strs(input.zone),
    deliverable: str(input.deliverable),
    verifier: str(input.verifier) || null,
  }
}

async function createTeam($: EngineInterface, input: Input): Promise<string> {
  const goal = str(input.goal).trim()
  const rolesIn = Array.isArray(input.roles) ? (input.roles as Input[]) : []
  if (!goal || rolesIn.length < 1) return 'team_create needs a goal and at least one role.'
  const roles = rolesIn.map(roleFrom)
  const names = new Set(roles.map(r => r.name))
  if (names.size !== roles.length || names.has('lead')) return 'Role names must be unique and none may be "lead".'
  for (const r of roles) if (r.verifier && !names.has(r.verifier)) return `Verifier "${r.verifier}" of ${r.name} is not a role.`
  const slug = slugify(str(input.slug) || goal)
  const base = await teamsDir($)
  const dir = `${base}/${slug}`
  if (await $.fs.exists(dir)) return `A team folder ${dir} exists already; choose another slug or close that team.`
  const at = await stamp($)
  const id = await $.session.id()
  const team: Team = {
    slug, goal, dir, root: await $.session.root(), lead: id, leadAddress: await ownAddress($), roles,
    rules: [...RULES, ...strs(input.rules)], created: at,
  }
  let ledger: Ledger = { next: 1, tasks: [] }
  for (const t of Array.isArray(input.tasks) ? (input.tasks as Input[]) : []) {
    const owner = slugify(str(t.owner))
    if (!names.has(owner)) return `Task "${str(t.title)}" names an owner that is not a role: ${owner}.`
    const verifier = str(t.verifier) || null
    if (verifier && !names.has(verifier)) return `Task "${str(t.title)}" names a verifier that is not a role: ${verifier}.`
    const added = addTask(ledger, { title: str(t.title), owner, depends_on: strs(t.depends_on), verifier }, at, 'lead')
    if ('error' in added) return `Task "${str(t.title)}": ${added.error}.`
    ledger = added.ledger
  }
  const question = `Start the team "${slug}" (${roles.length} roles: ${roles.map(r => r.name).join(', ')}) for: ${goal}?`
  const choice = await $.ui.ask(question, ['Start', 'Not now']).catch(() => 'Not now')
  if (choice !== 'Start') return `Not started. The draft:\n\n${cardText(team)}`
  await layOut($, team)
  await writeJson($, `${dir}/tasks.json`, ledger)
  await bindSession($, id, { dir, role: 'lead' })
  me = { team, role: 'lead' }
  meAt = await $.clock.now()
  const started = await startRoles($, team, ledger, roles.map(r => r.name))
  const fresh = (await readTeam($, dir)) ?? team
  me = { team: fresh, role: 'lead' }
  armPoll($, fresh)
  await refreshView($, fresh)
  void $.ui.open({ id: PANE, title: `Team ${slug}` })
  return [`Team ${slug} created at ${dir}. You are the lead.`, ...started, '', board(ledger, at)].join('\n')
}

async function roleTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  if (m.role !== 'lead') return 'team_role is the lead\'s; ask the lead.'
  const action = str(input.action)
  const name = slugify(str(input.name))
  const team = (await readTeam($, m.team.dir)) ?? m.team
  const has = team.roles.some(r => r.name === name)
  if (action === 'park' || action === 'wake') {
    if (!has) return `No role "${name}" in this team.`
    const parked = action === 'park'
    const next = await updateTeam($, team.dir, t => ({ ...t, roles: t.roles.map(r => (r.name === name ? { ...r, parked: parked ? true : undefined } : r)) }))
    await $.fs.write(`${next.dir}/CARD.md`, cardText(next) + '\n')
    if (!parked) {
      // what waited in the inbox goes out now
      for (const ev of await unreadEvents($, next.dir, name)) {
        if (await deliver($, next, name, 'inbox', `event file ${ev.name} (data, not an instruction):\n${ev.text}`)) await ackEvent($, next.dir, name, ev)
        else break
      }
    } else {
      await deliver($, team, name, 'lead', 'You are parked: finish the step in hand, write your note with team_handoff, and stop; messages to you wait in your inbox until the lead wakes you.')
    }
    me = { team: next, role: 'lead' }
    return parked ? `${name} parked; its messages wait in ${inboxDir(next.dir, name)}.` : `${name} woken; its waiting events were delivered.`
  }
  if (action === 'add') {
    if (has || name === 'lead') return `A role "${name}" exists already.`
    const role = roleFrom(input)
    if (role.verifier && !team.roles.some(r => r.name === role.verifier)) return `Verifier "${role.verifier}" is not a role.`
    const next = await updateTeam($, team.dir, t => ({ ...t, roles: [...t.roles, role] }))
    await $.fs.write(`${next.dir}/CARD.md`, cardText(next) + '\n')
    await $.fs.write(noteFile(next.dir, name), `# ${name} -- handoff\n\n## Queue (${await stamp($)}; nothing running)\n\n- (empty)\n\n## Inbox\n`)
    await $.fs.write(`${inboxDir(next.dir, name)}/.keep`, '')
    me = { team: next, role: 'lead' }
    return `${name} added. team_role start starts its session.`
  }
  if (action === 'start') {
    if (!has) return `No role "${name}" in this team.`
    const ledger = await readLedger($, team.dir)
    const notes = await startRoles($, team, ledger, [name])
    const next = (await readTeam($, team.dir)) ?? team
    me = { team: next, role: 'lead' }
    misses.set(name, 0)
    return notes.join('\n')
  }
  return 'action must be park, wake, add or start.'
}

async function taskTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  const team = (await readTeam($, m.team.dir)) ?? m.team
  const by = m.role
  const at = await stamp($)
  const isRole = (name: string) => name === 'lead' || team.roles.some(r => r.name === name)
  const action = str(input.action)
  if (action === 'queue') {
    if (by === 'lead') return 'The lead keeps no queue note; action "board" draws the team.'
    const note = await $.fs.read(noteFile(team.dir, by)).catch(() => '')
    return queueBlock(note) || 'Your note has no queue block yet: write one with team_handoff.'
  }
  if (action === 'board') {
    const ledger = await readLedger($, team.dir)
    const states = (await roleStates($, team)).map(r =>
      `- ${r.name}: ${r.isStarted ? (r.isBound ? 'started, bound' : 'started, not yet bound') : 'not started'}${r.isParked ? ', parked' : ''}${r.lastAt ? `; last turn ${r.lastAt}` : ''}${r.context !== undefined ? `; context ${r.context} %` : ''}${r.answer ? `; said: ${r.answer}` : ''}`)
    return [board(ledger, at), '', '## Roles', ...states].join('\n')
  }
  if (action === 'list') {
    const ledger = await readLedger($, team.dir)
    const owner = str(input.owner)
    const rows = ledger.tasks.filter(t => !owner || t.owner === owner)
    return rows.length ? rows.map(t => `${t.id} ${t.status} ${t.owner}: ${t.title}${t.depends_on.length ? ` (after ${t.depends_on.join(', ')})` : ''}`).join('\n') : 'No tasks.'
  }
  if (action === 'add') {
    const owner = str(input.owner) || by
    if (!isRole(owner)) return `No role "${owner}" in this team.`
    const verifier = str(input.verifier) || null
    if (verifier && !isRole(verifier)) return `No role "${verifier}" in this team.`
    const added = await updateLedger($, team.dir, ledger => {
      const r = addTask(ledger, { title: str(input.title), owner, depends_on: strs(input.depends_on), verifier, note: str(input.note) || undefined }, at, by)
      return 'error' in r ? { ledger, out: r } : { ledger: r.ledger, out: { task: r.task } }
    })
    if ('error' in added) return added.error
    const task = added.task
    const woke = task.status === 'ready' && owner !== by ? await wake($, team, by, [{ role: owner, kind: 'ready', task: task.id, text: `${task.id} is ready: ${task.title}` }]) : []
    return [`${task.id} ${task.status}: ${task.title}`, ...woke].join('\n')
  }
  if (action === 'set') {
    const id = str(input.id)
    const status = (str(input.status) || undefined) as Status | undefined
    const owner = str(input.owner) || undefined
    if (owner && !isRole(owner)) return `No role "${owner}" in this team.`
    const verifier = typeof input.verifier === 'string' ? input.verifier || null : undefined
    if (verifier && !isRole(verifier)) return `No role "${verifier}" in this team.`
    const set = await updateLedger($, team.dir, ledger => {
      const before = ledger.tasks.find(t => t.id === id)
      if (!before) return { ledger, out: { error: `no task ${id}` } as const }
      // The verifier's word is the verifier's: the owner neither closes the
      // task nor removes the verifier.
      if (before.verifier && by !== before.verifier && by !== 'lead') {
        if (status === 'done') return { ledger, out: { error: `${id} has a verifier (${before.verifier}): send it with status awaiting_verify; only the verifier or the lead marks it done.` } as const }
        if (verifier !== undefined) return { ledger, out: { error: `${id}'s verifier is changed by ${before.verifier} or the lead, not by ${by}.` } as const }
      }
      const args: SetArgs = {
        id, status, note: str(input.note) || undefined,
        artifact: input.artifact && typeof input.artifact === 'object' ? (input.artifact as { path: string; sha256?: string }) : undefined,
        depends_on: Array.isArray(input.depends_on) ? strs(input.depends_on) : undefined,
        verifier, owner, force: input.force === true,
      }
      const r = setTask(ledger, args, at, by)
      return 'error' in r ? { ledger, out: r } : { ledger: r.ledger, out: { task: r.task, wakes: r.wakes } }
    })
    if ('error' in set) return set.error
    const woke = await wake($, team, by, set.wakes)
    if (m.role === 'lead') await refreshView($, team)
    return [`${set.task.id} ${set.task.status}: ${set.task.title}`, ...woke].join('\n')
  }
  return 'action must be add, set, list, board or queue.'
}

async function handoffTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  const { team, role } = m
  if (role === 'lead') return 'The lead keeps no queue note; the ledger is its queue.'
  const path = noteFile(team.dir, role)
  const note = await $.fs.read(path).catch(() => `# ${role} -- handoff\n\n## Inbox\n`)
  const usage = await $.session.usage().catch(() => undefined)
  const context = usage?.context.percent
  const heading = [await stamp($), str(input.state) || 'state not given', `session ${await $.session.id()}`, context !== undefined ? `context ${context} %` : undefined].filter(Boolean).join('; ')
  await $.fs.write(path, replaceQueue(note, heading, str(input.queue)))
  return `Queue block written to ${path} (${heading}).`
}

// ---- The zone guard ---------------------------------------------------------

async function placed($: EngineInterface, path: string): Promise<string | undefined> {
  const home = await $.env.get('HOME')
  const spelled = path === '~' || path.startsWith('~/') ? `${home ?? ''}${path.slice(1)}` : path
  const abs = spelled.startsWith('/') ? spelled : `${await $.session.cwd()}/${spelled}`
  const own = await $.fs.stat(abs, { resolve: true }).catch(() => undefined)
  if (own?.realPath) return own.realPath
  const cut = abs.lastIndexOf('/')
  const dir = await $.fs.stat(abs.slice(0, cut + 1), { resolve: true }).catch(() => undefined)
  return dir?.realPath === undefined ? undefined : `${dir.realPath.replace(/\/$/, '')}/${abs.slice(cut + 1)}`
}

type Zone = { role: Role; allowed: string[] }

// The paths a member may write: its zone, and inside the team folder its
// own note and inbox; the roster and the ledger are the tools' to change.
// Undefined for the lead and for a session in no team.
async function zoneOf($: EngineInterface): Promise<Zone | undefined> {
  const m = await who($)
  if (!m || m.role === 'lead') return undefined
  const role = m.team.roles.find(r => r.name === m.role)
  if (!role) return undefined
  const resolved = async (p: string) => (await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath ?? p
  const root = (await resolved(m.team.root)).replace(/\/$/, '')
  const dir = (await resolved(m.team.dir)).replace(/\/$/, '')
  return { role, allowed: [`${dir}/handoff/${role.name}.md`, `${dir}/inbox/${role.name}`, ...role.zone.map(z => `${root}/${z.replace(/^\.?\//, '').replace(/\/$/, '')}`)] }
}

const isInside = (zone: Zone, real: string) => zone.allowed.some(a => real === a || real.startsWith(`${a}/`))

async function outsideZone($: EngineInterface, path: string): Promise<string | undefined> {
  const zone = await zoneOf($)
  if (!zone) return undefined
  const real = await placed($, path)
  if (real === undefined) return `${$.plugin.name}: cannot place ${path}; a member edits only inside its zone`
  return isInside(zone, real) ? undefined : `${$.plugin.name}: ${path} is outside the zone of the role "${zone.role.name}" (${zone.role.zone.join(', ') || 'none'}); ask the owner of that path, or the lead.`
}

// The second layer: what a Bash command writes, read off its text.
async function bashOutsideZone($: EngineInterface, command: string): Promise<string | undefined> {
  const zone = await zoneOf($)
  if (!zone) return undefined
  const targets = writeTargets(command)
  if (!targets) return undefined
  if (targets.isWholeTree) return `${$.plugin.name}: ${targets.verbs.join(', ')} rewrites the tree; a member of the role "${zone.role.name}" asks the lead for that.`
  for (const p of targets.paths) {
    const real = await placed($, p)
    if (real === undefined || !isInside(zone, real))
      return `${$.plugin.name}: ${targets.verbs.join(', ')} would write ${p}, outside the zone of the role "${zone.role.name}" (${zone.role.zone.join(', ') || 'none'}); ask the owner of that path, or the lead.`
  }
  return undefined
}

// ---- Commands ---------------------------------------------------------------

async function statusText($: EngineInterface, m: Membership): Promise<string> {
  const team = (await readTeam($, m.team.dir)) ?? m.team
  const text = await taskTool($, { team, role: m.role }, { action: 'board' })
  const unread = await unreadEvents($, team.dir, 'lead')
  return unread.length ? `${text}\n\n## Unread events for the lead: ${unread.length}\n${unread.map(e => `- ${e.name}`).join('\n')}` : text
}

async function closeTeam($: EngineInterface, m: Membership): Promise<string> {
  const closed = await stamp($)
  const team = (await readTeam($, m.team.dir)) ?? m.team
  const told: string[] = []
  for (const r of team.roles) {
    const ok = await deliver($, { ...team, roles: team.roles.map(x => ({ ...x, parked: undefined })) }, r.name, 'lead', `The team ${team.slug} is closed at ${closed}: finish the step in hand, write your note with team_handoff, and stop. Your membership ends with this message.`)
    told.push(`${r.name}: ${ok ? 'told' : 'not reachable'}`)
    if (r.sessionId) await unbindSession($, r.sessionId).catch(() => undefined)
  }
  await updateTeam($, team.dir, t => ({ ...t, closed }))
  await unbindSession($, team.lead).catch(() => undefined)
  poll?.cancel()
  poll = undefined
  me = undefined
  meAt = 0
  return `Team ${team.slug} closed at ${closed}; its folder stays at ${team.dir}. ${told.join(', ')}.`
}

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
    if (got.me.role !== 'lead') return { text: 'Only the lead closes the team.' }
    return {
      text: await closeTeam($, got.me),
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

// A member reads its card and rules in the system prompt; the lead its
// card. Static text, or nothing outside a team; hooks/register.ts adds it
// in the plugin's one prompt.compose hook.
export async function teamSection($: EngineInterface): Promise<PromptComposeSection | undefined> {
  const m = await who($)
  if (!m) return undefined
  let text: string
  if (m.role === 'lead') {
    text = leadSection(m.team)
  } else {
    const role = m.team.roles.find(r => r.name === m.role)
    if (!role) return undefined
    text = memberSection(m.team, role)
  }
  return { id: `${$.plugin.name}:team`, text, scope: 'session' }
}

// Called from the plugin's one session.start hook (hooks/register.ts).
export async function startTeam($: EngineInterface): Promise<void> {
  await $.command.register({ name: 'team', description: 'A team of sessions for one task: /team <task> drafts it, "status" draws the board, "close" ends it', argumentHint: '<task> | status | close' })
  for (const tool of TOOLS) await $.tool.register(tool)
  await $.agent.register({
    name: CRITIC,
    description: 'The team critic: a fresh reader of one result before its verifier sees it. Spawned by mcp__rp__team_critic, not by the model.',
    prompt: CRITIC_PROMPT,
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: 'opus',
  }).catch(err => $.ui.log(`${$.plugin.name}: the critic agent could not be registered: ${String(err)}`, { to: 'debug' }))
  me = undefined
  meAt = 0
  rebind = undefined
  myAddress = undefined
  poll?.cancel()
  poll = undefined
  polling = false
  misses.clear()
  pending.clear()
  const m = await who($)
  if (m?.role === 'lead') {
    armPoll($, m.team)
    await refreshView($, m.team)
  }
}

export function registerTeam(on: On): void {
  on('command.run', { command: 'team' }, ($, e) => teamCommand($, e.args))
  on('command.run', { command: 'rp:team' }, ($, e) => teamCommand($, e.args))

  // The critic is the tool's to spawn, never the model's.
  on('agent.offer', { agent: `rp:${CRITIC}` }, () => ({ isOffered: false }))

  // The brief's first line binds a fresh session to its role before the
  // model reads a word; nothing else about the prompt changes.
  on('prompt.submit', async ($, e, next) => {
    const mark = e.text.match(BRIEF_MARK)
    if (mark && !(await who($))) {
      const [, slug, role, dir] = mark
      await bindAs($, dir ?? '', role ?? '').then(
        t => $.ui.log(`${$.plugin.name}: bound to team ${t.team.slug} as ${role}`, { to: 'debug' }),
        err => $.ui.log(`${$.plugin.name}: could not bind to team ${slug} as ${role}: ${String(err)}; the model may call team_join`),
      )
    }
    return next(e)
  })

  on('tool.call', { tool: 'mcp__rp__team_create' }, ($, e) => safely(() => createTeam($, e as unknown as Input)))

  on('tool.call', { tool: 'mcp__rp__team_join' }, ($, e) =>
    safely(async () => {
      const input = e as unknown as Input
      const slug = slugify(str(input.team))
      const role = slugify(str(input.role))
      const dir = str(input.dir) || (await listTeams($)).find(t => t.slug === slug && !t.closed)?.dir
      if (!dir) return `No open team "${slug}" here; pass its folder as dir.`
      const team = await readTeam($, dir)
      if (!team || team.closed) return `No open team at ${dir}.`
      if (!team.roles.some(x => x.name === role)) return `No role "${role}" in team ${team.slug}.`
      const bound = await bindAs($, dir, role)
      return `Joined team ${bound.team.slug} as ${role}. Card: ${bound.team.dir}/CARD.md`
    }),
  )

  on('tool.call', { tool: 'mcp__rp__team_task' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($)
      return 'text' in got ? got.text : taskTool($, got.me, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_handoff' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($)
      return 'text' in got ? got.text : handoffTool($, got.me, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_critic' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($)
      return 'text' in got ? got.text : criticTool($, got.me, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_role' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($)
      return 'text' in got ? got.text : roleTool($, got.me, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_notify' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($)
      if ('text' in got) return got.text
      const input = e as unknown as Input
      const role = str(input.role) === 'lead' ? 'lead' : slugify(str(input.role))
      if (role !== 'lead' && !got.me.team.roles.some(r => r.name === role)) return `No role "${role}" in this team.`
      return notify($, got.me.team, role, got.me.role, str(input.text), str(input.path) || undefined)
    }),
  )

  // A member edits only inside its zone and its own files of the team folder.
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
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const why = await bashOutsideZone($, e.command)
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

  // Each main-loop turn leaves the member's state for the lead's board; a
  // critic's turn answers the team_critic call that waits for it.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) {
      pending.get(e.agentId)?.(e.answer)
      return done
    }
    const m = await who($)
    if (!m) return done
    const usage = await $.session.usage().catch(() => undefined)
    await $.fs.write(stateFile(m.team.dir, m.role), JSON.stringify({
      at: await stamp($), reason: e.reason, context: usage?.context.percent, answer: e.answer.replace(/\s+/g, ' ').slice(0, 200),
    }, null, 2) + '\n').catch(() => undefined)
    if (m.role === 'lead') await refreshView($, m.team).catch(() => undefined)
    return done
  })

  // A /clear or a resume keeps the process and changes the id: the
  // membership is carried over by the next hook that asks who this is.
  on('session.end', async ($, e, next) => {
    const m = await who($)
    if (m) await appendInbox($, m.team.dir, m.role, `${await stamp($)} session ended (${e.reason}), id ${e.sessionId}`).catch(() => undefined)
    poll?.cancel()
    poll = undefined
    rebind = e.reason === 'clear' || e.reason === 'resume' ? m : undefined
    me = undefined
    meAt = 0
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
            <Text color={r.isParked ? 'warning' : r.isBound ? 'success' : r.isStarted ? 'warning' : 'error'}>{r.isParked ? '◌' : r.isBound ? '●' : r.isStarted ? '◐' : '○'}</Text>
            <Text> {r.name}</Text>
            <Text dimColor>{r.isParked ? '  parked' : ''}{r.context !== undefined ? `  ctx ${r.context}%` : ''}{r.lastAt ? `  ${r.lastAt}` : ''}</Text>
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
