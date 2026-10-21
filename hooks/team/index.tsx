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
import type { Evidence, Finding } from './audit'
import { auditText, doneClaims, renderFindings } from './audit'
import { writeTargets } from './bashzone'
import type { Role, Team } from './card'
import { BRIEF_MARK, RULES, brief, cardText, leadSection, memberSection, slugify } from './card'
import type { CriticRun, DigestMessage, Prediction } from './critic'
import {
  CRITIC_SYSTEM, MAX_ROUNDS, applyVerdicts, debatePrompt, digest, factsPrompt, logicPrompt, mergeReplies, metrics, metricsLine, openBlocking,
  parseFindings, predictionScore, renderRun, reviewPrompt, scoreText,
} from './critic'
import type { Membership } from './folder'
import {
  ackEvent, appendInbox, bindSession, ensureBase, inboxDir, layOut, listTeams, membership, noteFile, queueBlock, readJson, readLedger, readTeam,
  replaceQueue, stateFile, teamsDir, unbindSession, unreadEvents, updateLedger, updateTeam, writeEvent, writeJson,
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
// Critic runs waiting for their agent's turn.complete: agent id -> the file
// the answer is written to. A hook has 10 s of its own time per dispatch
// and a `$` call's time is free, so the wait is a `$.process.run` that
// watches for the file, never a promise of the module's own.
const pending = new Map<string, string>()
// Every critic agent spawned this session: its Bash is held to reading.
const critics = new Set<string>()

type Input = Record<string, unknown>
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

async function stamp($: EngineInterface): Promise<string> {
  return new Date(await $.clock.now()).toISOString().slice(0, 16) + 'Z'
}

// This session's desktop address, when the app's tool is there to ask;
// asked once per session, a miss included.
let addressAsked = false
async function ownAddress($: EngineInterface): Promise<string | undefined> {
  if (myAddress || addressAsked) return myAddress
  addressAsked = true
  const tools = (await $.tool.list().catch(() => [])).map(t => t.name)
  if (!tools.includes(GET_SESSION)) return undefined
  const ran = await $.tool.call({ tool: GET_SESSION, session_id: 'self' } as never).catch(() => undefined)
  myAddress = ran && 'text' in ran ? ran.text?.match(/local_[0-9a-f-]{8,}/)?.[0] : undefined
  return myAddress
}

// The desktop app's own message tool: the path proved to wake a stopped
// session (2026-09-30), tried when the engine's send does not deliver.
const SEND_MESSAGE = 'mcp__ccd_session_mgmt__send_message'
async function sendByApp($: EngineInterface, address: string, text: string): Promise<boolean> {
  const tools = (await $.tool.list().catch(() => [])).map(t => t.name)
  if (!tools.includes(SEND_MESSAGE)) return false
  const ran = await $.tool.call({ tool: SEND_MESSAGE, session_id: address, message: text } as never).catch(() => undefined)
  return Boolean(ran && 'text' in ran && ran.text && /delivered|queued/i.test(ran.text) && !ran.isError)
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
  meAt = Date.now()
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

// The cache's clock is the module's own (Date.now), not `$.clock.now`: a
// hook on every tool call must not cost a dispatch, and the engine's clock
// is for stamps.
async function who($: EngineInterface): Promise<Membership | undefined> {
  const now = Date.now()
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
  const body = `[rp team ${team.slug}] from ${from}: ${text}`
  const sent = await $.session.send({ to, text: body }).catch(() => ({ isDelivered: false as const }))
  if (sent.isDelivered) return true
  // a desktop address the engine could not reach: the app's own tool
  return typeof to === 'string' && to.startsWith('local_') ? sendByApp($, to, body) : false
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

// The record of this session, as the mechanical audit reads it.
async function evidenceOf($: EngineInterface): Promise<Evidence> {
  const messages = await $.session.messages().catch(() => [] as DigestMessage[])
  const toolTexts: string[] = []
  const commands: string[] = []
  const writtenPaths: string[] = []
  for (const m of messages) {
    for (const t of m.toolUses ?? []) {
      if (t.text) toolTexts.push(t.text)
      if (t.tool === 'Bash' && typeof t.input.command === 'string') commands.push(t.input.command)
      const p = t.input.file_path ?? t.input.notebook_path
      if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(t.tool) && typeof p === 'string') writtenPaths.push(p)
    }
  }
  return { toolTexts, commands, writtenPaths }
}

// The file half of the audit: a file the result says it wrote exists and
// is newer than the session's start. A relative path that is not under the
// session's directory is looked for among the paths the session wrote.
async function fileFindings($: EngineInterface, result: string, evidence: Evidence): Promise<Finding[]> {
  const out: Finding[] = []
  const since = (await $.session.usage().catch(() => undefined))?.startedAt ?? 0
  for (const p of doneClaims(result).files.slice(0, 20)) {
    let real = await placed($, p)
    let st = real ? await $.fs.stat(real).catch(() => undefined) : undefined
    if (!st && !p.startsWith('/')) {
      const tail = `/${p.replace(/^\.\//, '')}`
      const written = (evidence.writtenPaths ?? []).find(w => w.endsWith(tail))
      if (written) {
        real = written
        st = await $.fs.stat(written).catch(() => undefined)
      }
    }
    if (!st) out.push({ kind: 'file', severity: 'blocking', text: `the result says ${p} was written, but it does not exist` })
    else if (st.kind === 'file' && since && st.mtimeMs < since) out.push({ kind: 'file', severity: 'note', text: `${p} is older than this session (${new Date(st.mtimeMs).toISOString()}): not written here` })
  }
  return out
}

async function auditOf($: EngineInterface, result: string): Promise<string> {
  const evidence = await evidenceOf($)
  return renderFindings(auditText(result, evidence), await fileFindings($, result, evidence))
}

async function subjectText($: EngineInterface, input: Input): Promise<{ subject: string; text: string } | { error: string }> {
  const path = str(input.path)
  const claim = str(input.claim) || str(input.text)
  if (!path && !claim) return { error: 'name a path (the result to read) or a claim/text (the sentence to check), or both.' }
  let text = claim
  if (path) {
    const read = await $.fs.read(path).catch(() => undefined)
    if (read === undefined) return { error: `cannot read ${path}` }
    text = claim ? `${read}\n\n${claim}` : read
  }
  return { subject: path ? (claim ? `${path} and the claim "${claim}"` : path) : `the claim "${claim}"`, text }
}

// The language the user wrote in last, for the critics' replies.
async function userLanguage($: EngineInterface): Promise<string> {
  const messages = await $.session.messages().catch(() => [] as DigestMessage[])
  const last = [...messages].reverse().find(m => m.role === 'user' && m.text.trim())
  return last && /[А-Яа-яЁё]/.test(last.text) ? 'Russian' : 'English'
}

// The team's own checklist and the project's, when they exist.
async function checklistText($: EngineInterface, team: Team): Promise<string> {
  const parts: string[] = []
  const own = await $.fs.read(`${team.dir}/CHECKLIST.md`).catch(() => '')
  if (own.trim()) parts.push(own.trim())
  for (const p of [`${team.root}/.claude/critic-checklist.md`, `${team.root}/docs/agents/critic-checklist.md`]) {
    const t = await $.fs.read(p).catch(() => '')
    if (t.trim()) {
      parts.push(`Project checklist ${p}:\n${t.slice(0, 12_000)}`)
      break
    }
  }
  return parts.join('\n\n')
}

const runsDir = (team: Team) => `${team.dir}/critic`
const runFile = (team: Team, id: string) => `${runsDir(team)}/${id}.json`

async function readRun($: EngineInterface, team: Team, id: string): Promise<CriticRun | undefined> {
  return readJson<CriticRun | undefined>($, runFile(team, id), undefined).catch(() => undefined)
}

async function saveRun($: EngineInterface, team: Team, run: CriticRun): Promise<void> {
  await writeJson($, runFile(team, run.id), run)
  await $.fs.write(`${runsDir(team)}/${run.id}.md`, renderRun(run) + '\n')
}

async function allRuns($: EngineInterface, team: Team): Promise<CriticRun[]> {
  const entries = await $.fs.list(runsDir(team)).catch(() => [])
  const runs: CriticRun[] = []
  for (const e of entries) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    const r = await readRun($, team, e.name.slice(0, -5))
    if (r) runs.push(r)
  }
  return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

// One critic: spawned as the plugin's agent type, answered by its
// turn.complete into a file this call waits for; an error after
// CRITIC_WAIT_MS.
async function askCritic($: EngineInterface, team: Team, prompt: string, description: string): Promise<string> {
  const spawned = await $.agent.spawn({ prompt, subagentType: `${$.plugin.name}:${CRITIC}`, description: description.slice(0, 80) }).catch(err => ({ deny: String(err) }))
  if ('deny' in spawned && spawned.deny) throw new Error(`the critic could not start: ${spawned.deny}`)
  if (!('agentId' in spawned) || !spawned.agentId) throw new Error('the critic could not start: no agent id')
  const agentId = spawned.agentId
  critics.add(agentId)
  const file = `${runsDir(team)}/.reply-${agentId.replace(/[^A-Za-z0-9_-]/g, '')}`
  pending.set(agentId, file)
  try {
    const waited = await $.process.run(['sh', '-c', `until [ -f "$1" ]; do sleep 2; done`, 'wait', file], { timeoutMs: CRITIC_WAIT_MS }).catch(() => undefined)
    const text = waited ? await $.fs.read(file).catch(() => '') : ''
    if (!text) throw new Error(`the critic (agent ${agentId}) gave no answer within ${CRITIC_WAIT_MS / 60_000} minutes`)
    return text
  } finally {
    pending.delete(agentId)
    await $.process.run(['rm', '-f', file], { timeoutMs: 5000 }).catch(() => undefined)
  }
}

// The task's critic record follows the run: what it still holds open.
async function recordOnTask($: EngineInterface, m: Membership, run: CriticRun): Promise<string> {
  if (!run.task) return ''
  const at = await stamp($)
  const open = openBlocking(run)
  const summary = `${run.findings.length} finding(s), ${open} open blocking, round ${run.round}`
  const err = await updateLedger($, m.team.dir, ledger => {
    const r = setTask(ledger, { id: run.task ?? '', critic: { at, summary, run: run.id, openBlocking: open } }, at, m.role)
    return 'error' in r ? { ledger, out: r.error } : { ledger: r.ledger, out: undefined }
  })
  return err ? `\n\n(not recorded on ${run.task}: ${err})` : `\n\n(recorded on ${run.task}: ${summary})`
}

async function criticTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  const got = await subjectText($, input)
  if ('error' in got) return `team_critic: ${got.error}`
  const mode: CriticRun['mode'] = str(input.mode) === 'heavy' ? 'heavy' : 'light'
  const purpose = str(input.purpose) || 'a result of the team'
  const taskId = str(input.task) || undefined
  const at = await stamp($)
  const lang = await userLanguage($)
  const checklist = await checklistText($, m.team)
  const predictions = await readJson<Prediction[]>($, `${m.team.dir}/predictions.json`, []).catch(() => [] as Prediction[])
  const score = scoreText(predictionScore(predictions, m.role))
  const audit = await auditOf($, got.text)
  const head = [`Team "${m.team.slug}", role "${m.role}". The card: ${m.team.dir}/CARD.md.`, taskId ? `The result belongs to task ${taskId} of ${m.team.dir}/tasks.json.` : ''].filter(Boolean).join('\n')
  const asks = [askCritic($, m.team, `${head}\n\n${factsPrompt({ subject: got.subject, purpose, audit, checklist, score, userLanguage: lang })}`, `facts critic: ${taskId || got.subject}`)]
  if (mode === 'heavy') asks.push(askCritic($, m.team, `${head}\n\n${logicPrompt({ subject: got.subject, purpose, checklist, userLanguage: lang })}`, `logic critic: ${taskId || got.subject}`))
  const replies = await Promise.all(asks)
  const merged = mergeReplies(replies)
  const id = `R${at.replace(/\D/g, '').slice(2, 12)}-${m.role}`
  const run: CriticRun = { id, kind: 'artifact', subject: got.subject, role: m.role, task: taskId, mode, round: 1, startedAt: at, updatedAt: at, findings: merged.findings, notes: `${audit}\n\n${merged.notes}` }
  await saveRun($, m.team, run)
  return `${renderRun(run)}\n\nAnswer each finding with team_answer (run ${id}); up to ${MAX_ROUNDS} rounds.${await recordOnTask($, m, run)}`
}

async function answerTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  const id = str(input.run)
  const run = id ? await readRun($, m.team, id) : undefined
  if (!run) return `No critic run "${id}" in this team (${runsDir(m.team)}).`
  if (run.round >= MAX_ROUNDS) return `Run ${id} has had its ${MAX_ROUNDS} rounds; what is still OPEN goes to the verifier or the user as it stands.`
  const answers = (Array.isArray(input.answers) ? (input.answers as Input[]) : []).map(a => ({ id: str(a.id), status: str(a.status), evidence: str(a.evidence) }))
  if (answers.length === 0) return 'team_answer needs answers: [{ id: "F1", status: "fixed|refuted|user|cannot", evidence: "..." }].'
  for (const a of answers) {
    if (!run.findings.some(f => f.id === a.id)) return `No finding ${a.id} in run ${id}.`
    if (!['fixed', 'refuted', 'user', 'cannot'].includes(a.status)) return `${a.id}: status must be fixed, refuted, user or cannot.`
  }
  const withAnswers: CriticRun = { ...run, findings: run.findings.map(f => ({ ...f, answer: answers.find(a => a.id === f.id)?.evidence ?? f.answer })) }
  const reply = await askCritic($, m.team, debatePrompt(withAnswers, answers, await userLanguage($)), `critic round ${run.round + 1}: ${run.subject}`)
  const next = { ...applyVerdicts(withAnswers, reply), updatedAt: await stamp($) }
  await saveRun($, m.team, next)
  if (next.kind === 'review') await $.fs.write(`${m.team.dir}/review/ledger-${next.id}.md`, renderRun(next) + '\n')
  const open = openBlocking(next)
  return `${renderRun(next)}\n\n${open === 0 ? 'No blocking finding is open.' : `${open} blocking finding(s) still open${next.round >= MAX_ROUNDS ? '; the rounds are spent' : `; ${MAX_ROUNDS - next.round} round(s) left`}.`}${await recordOnTask($, m, next)}`
}

async function reviewTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  await ensureBase($, await teamsDir($))
  const dir = `${m.team.dir}/review`
  const prior = (await $.fs.list(dir).catch(() => [])).filter(e => e.kind === 'file' && /^ledger-.*\.md$/.test(e.name)).map(e => `${dir}/${e.name}`).sort()
  const k = (await $.fs.list(dir).catch(() => [])).filter(e => e.kind === 'file' && /^digest-\d+\.md$/.test(e.name)).reduce((n, e) => Math.max(n, Number(e.name.match(/\d+/)?.[0] ?? 0)), 0) + 1
  const messages = await $.session.messages().catch(() => [] as DigestMessage[])
  const digestPath = `${dir}/digest-${k}.md`
  await $.fs.write(digestPath, digest(messages) + '\n')
  const cwd = await $.session.cwd()
  const status = await $.process.run(['git', 'status', '--short'], { cwd, timeoutMs: 10_000 }).catch(() => undefined)
  const log = await $.process.run(['git', 'log', '--oneline', '-15'], { cwd, timeoutMs: 10_000 }).catch(() => undefined)
  const git = status && status.exitCode === 0 ? `status:\n${status.stdout.trim() || '(clean)'}\nlog:\n${log?.stdout.trim() ?? ''}` : ''
  const at = await stamp($)
  const reply = await askCritic($, m.team, reviewPrompt({ digestPath, cwd, git, focus: str(input.focus), checklist: await checklistText($, m.team), priorLedgers: prior, userLanguage: await userLanguage($) }), `session review ${k}: ${m.role}`)
  const parsed = parseFindings(reply)
  const run: CriticRun = { id: `review-${k}-${m.role}`, kind: 'review', subject: `session of ${m.role}, digest ${digestPath}`, role: m.role, mode: 'light', round: 1, startedAt: at, updatedAt: at, findings: parsed.findings, notes: parsed.notes }
  await saveRun($, m.team, run)
  await $.fs.write(`${dir}/ledger-${run.id}.md`, renderRun(run) + '\n')
  return `${renderRun(run)}\n\nAnswer each finding with team_answer (run ${run.id}); findings marked USER go to the person as they stand.`
}

async function checklistTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  const path = `${m.team.dir}/CHECKLIST.md`
  const current = await $.fs.read(path).catch(() => '')
  if (str(input.action) !== 'add') return current.trim() || 'The team checklist is empty: team_checklist add "<the mistake, the case>" after a finding settles as a real mistake.'
  const line = str(input.line).trim()
  if (!line) return 'team_checklist add needs the line: the mistake and the case it comes from.'
  const n = (current.match(/^\d+\./gm) ?? []).length + 1
  const text = `${current.trim() ? current.trimEnd() : '# Team checklist\n\nOne line per question, each born from a mistake this team made; the date and the case are why the line exists. Appended, never reworded.'}\n${n}. (${await stamp($)}, ${m.role}) ${line}\n`
  await $.fs.write(path, text)
  return `Checklist line ${n} added.`
}

async function predictTool($: EngineInterface, m: Membership, input: Input): Promise<string> {
  const path = `${m.team.dir}/predictions.json`
  const list = await readJson<Prediction[]>($, path, [])
  const action = str(input.action)
  if (action === 'add') {
    const text = str(input.text).trim()
    if (!text) return 'team_predict add needs the text: what you expect before the run.'
    const id = `P-${String(list.length + 1).padStart(4, '0')}`
    await writeJson($, path, [...list, { id, role: m.role, text, task: str(input.task) || undefined, at: await stamp($) }])
    return `${id} recorded: ${text}`
  }
  if (action === 'resolve') {
    const id = str(input.id)
    const outcome = str(input.outcome) as Prediction['outcome']
    const p = list.find(x => x.id === id)
    if (!p) return `No prediction ${id}.`
    if (!outcome || !['hit', 'miss', 'partial'].includes(outcome)) return 'outcome must be hit, miss or partial.'
    await writeJson($, path, list.map(x => (x.id === id ? { ...x, outcome, note: str(input.note) || x.note } : x)))
    return `${id} ${outcome}: ${p.text}`
  }
  const roles = [...new Set(list.map(p => p.role))].sort()
  const open = list.filter(p => !p.outcome)
  return [
    ...roles.map(r => `${r}: ${scoreText(predictionScore(list, r))}`),
    ...(open.length ? ['', 'unresolved:', ...open.map(p => `- ${p.id} ${p.role}: ${p.text}`)] : []),
  ].join('\n') || 'No predictions yet.'
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
    name: 'team_audit',
    description: 'The mechanical audit of a result against this session\'s record, no model: every figure must appear in a tool output, every quoted command must have been run, every file said written must exist, "tests pass" needs a passing run, "committed" needs git commit, and every "a + b = c" must add up.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'The result to audit (a file)' }, text: { type: 'string', description: 'Or the text itself' } },
    },
  },
  {
    name: 'team_critic',
    description: 'A fresh-eyes read of a result by the critic subagent (Opus) before it goes to its verifier: the mechanical audit first, then claim cards, one figure reproduced, the checklist, the breaker. mode "heavy" adds a second critic for the logic (premises, rivals, scope). Findings carry ids and statuses; answer them with team_answer. With a task id the run is recorded on the task, and awaiting_verify needs it with no open blocking finding.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The result to read (a file)' },
        claim: { type: 'string', description: 'The sentence to check' },
        task: { type: 'string', description: 'The task the result belongs to, T-NNNN' },
        mode: { type: 'string', enum: ['light', 'heavy'], description: 'heavy: facts and logic critics both; for a figure or conclusion that reaches the lead or the person' },
        purpose: { type: 'string', description: 'What the result is for: a message, a commit, a handoff' },
      },
    },
  },
  {
    name: 'team_answer',
    description: 'One round of the debate on a critic run: answer each finding with evidence (fixed: what and where; refuted: the evidence; user: the person must decide; cannot: why), the critic re-checks and sets each status. Up to 3 rounds; an honest OPEN is a valid end.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'The run id from team_critic or team_review' },
        answers: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string', enum: ['fixed', 'refuted', 'user', 'cannot'] }, evidence: { type: 'string' } }, required: ['id', 'status', 'evidence'] },
        },
      },
      required: ['run', 'answers'],
    },
  },
  {
    name: 'team_review',
    description: 'The critic of this whole session: a digest of the transcript goes to a fresh critic (Opus) that maps the main claims of the user and the agent alike, verifies the key ones, looks for prior work, walks the checklist and names the breaker. Earlier reviews of this team are read first. Run at a milestone or before /team close.',
    inputSchema: { type: 'object', properties: { focus: { type: 'string', description: 'What to look at in particular' } } },
  },
  {
    name: 'team_checklist',
    description: 'The team\'s own checklist of mistakes: show it, or add one line after a finding settled as a real mistake (the mistake and the case). Every critic reads it. Appended, never reworded.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['show', 'add'] }, line: { type: 'string' } }, required: ['action'] },
  },
  {
    name: 'team_predict',
    description: 'Predictions: before a run, add what you expect; after it, resolve hit, miss or partial. The critics quote your score where you speak with certainty; the board shows it per role.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'resolve', 'score'] },
        text: { type: 'string' }, task: { type: 'string' }, id: { type: 'string' },
        outcome: { type: 'string', enum: ['hit', 'miss', 'partial'] }, note: { type: 'string' },
      },
      required: ['action'],
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

// A session of no team, for the tools that work without one: its own
// folder `_sessions/<id>` beside the teams, no roles, itself the lead.
async function soloMembership($: EngineInterface): Promise<Membership> {
  const id = await $.session.id()
  const dir = `${await teamsDir($)}/_sessions/${id}`
  return {
    role: 'lead',
    team: { slug: `session-${id.slice(0, 8)}`, goal: 'this session alone', dir, root: await $.session.root(), lead: id, roles: [], rules: [...RULES], created: await stamp($) },
  }
}

// Who is calling: the session's membership, or, for a call made inside a
// subagent that is a role (the terminal fallback), that role.
async function teamOf($: EngineInterface, agentId?: string): Promise<{ me: Membership } | { text: string }> {
  const m = await who($)
  if (!m) return { text: 'This session is in no team. /team <task> drafts one; mcp__rp__team_join joins one.' }
  if (agentId) {
    const role = m.team.roles.find(r => r.agentId === agentId)
    if (role) return { me: { team: m.team, role: role.name } }
  }
  return { me: m }
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
  meAt = Date.now()
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
    const runs = await allRuns($, team)
    const predictions = await readJson<Prediction[]>($, `${team.dir}/predictions.json`, []).catch(() => [] as Prediction[])
    const errors = metrics(runs).map(x => `- ${metricsLine(x)}`)
    const scores = [...new Set(predictions.map(p => p.role))].sort().map(r => `- ${r}: ${scoreText(predictionScore(predictions, r))}`)
    return [
      board(ledger, at), '', '## Roles', ...states,
      ...(errors.length ? ['', '## Errors found by the critics', ...errors] : []),
      ...(scores.length ? ['', '## Predictions', ...scores] : []),
    ].join('\n')
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
async function zoneOf($: EngineInterface, agentId?: string): Promise<Zone | undefined> {
  const got = await teamOf($, agentId)
  if ('text' in got) return undefined
  const m = got.me
  if (m.role === 'lead') return undefined
  const role = m.team.roles.find(r => r.name === m.role)
  if (!role) return undefined
  const resolved = async (p: string) => (await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath ?? p
  const root = (await resolved(m.team.root)).replace(/\/$/, '')
  const dir = (await resolved(m.team.dir)).replace(/\/$/, '')
  return { role, allowed: [`${dir}/handoff/${role.name}.md`, `${dir}/inbox/${role.name}`, ...role.zone.map(z => `${root}/${z.replace(/^\.?\//, '').replace(/\/$/, '')}`)] }
}

const isInside = (zone: Zone, real: string) => zone.allowed.some(a => real === a || real.startsWith(`${a}/`))

async function outsideZone($: EngineInterface, path: string, agentId?: string): Promise<string | undefined> {
  const zone = await zoneOf($, agentId)
  if (!zone) return undefined
  const real = await placed($, path)
  if (real === undefined) return `${$.plugin.name}: cannot place ${path}; a member edits only inside its zone`
  return isInside(zone, real) ? undefined : `${$.plugin.name}: ${path} is outside the zone of the role "${zone.role.name}" (${zone.role.zone.join(', ') || 'none'}); ask the owner of that path, or the lead.`
}

// The second layer: what a Bash command writes, read off its text.
async function bashOutsideZone($: EngineInterface, command: string, agentId?: string): Promise<string | undefined> {
  // a critic reads; its Bash never writes
  if (agentId && critics.has(agentId)) {
    const targets = writeTargets(command)
    return targets ? `${$.plugin.name}: the critic only reads; ${targets.verbs.join(', ')} would write (${targets.isWholeTree ? 'the tree' : targets.paths.join(', ')}).` : undefined
  }
  const zone = await zoneOf($, agentId)
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
  // A different model from the author's, so the blind spots differ: Opus
  // for a session on anything else, Sonnet for a session on Opus (the
  // operator allows nothing above Opus for a subagent).
  const main = await $.session.model().catch(() => '')
  const criticModel = /opus/i.test(main) ? 'sonnet' : 'opus'
  await $.agent.register({
    name: CRITIC,
    description: 'The team critic: a fresh reader of a result or a session. Spawned by mcp__rp__team_critic, team_answer and team_review, not by the model.',
    prompt: CRITIC_SYSTEM,
    tools: ['Read', 'Grep', 'Glob', 'Bash'],
    model: criticModel,
  }).catch(err => $.ui.log(`${$.plugin.name}: the critic agent could not be registered: ${String(err)}`, { to: 'debug' }))
  me = undefined
  meAt = 0
  rebind = undefined
  myAddress = undefined
  addressAsked = false
  poll?.cancel()
  poll = undefined
  polling = false
  misses.clear()
  pending.clear()
  critics.clear()
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
      const got = await teamOf($, e.agentId)
      return 'text' in got ? got.text : taskTool($, got.me, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_handoff' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($, e.agentId)
      return 'text' in got ? got.text : handoffTool($, got.me, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_critic' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($, e.agentId)
      return 'text' in got ? got.text : criticTool($, got.me, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_answer' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($, e.agentId)
      return 'text' in got ? got.text : answerTool($, got.me, e as unknown as Input)
    }),
  )
  // A review needs no team: outside one, the session reviews itself into
  // a folder of its own beside the teams.
  on('tool.call', { tool: 'mcp__rp__team_review' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($, e.agentId)
      const m = 'me' in got ? got.me : await soloMembership($)
      return reviewTool($, m, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_checklist' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($, e.agentId)
      return 'text' in got ? got.text : checklistTool($, got.me, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_predict' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($, e.agentId)
      return 'text' in got ? got.text : predictTool($, got.me, e as unknown as Input)
    }),
  )
  // The audit works in any session: outside a team it reads the result
  // against this session's record all the same.
  on('tool.call', { tool: 'mcp__rp__team_audit' }, ($, e) =>
    safely(async () => {
      const got = await subjectText($, e as unknown as Input)
      if ('error' in got) return `team_audit: ${got.error}`
      return auditOf($, got.text)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_role' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($, e.agentId)
      return 'text' in got ? got.text : roleTool($, got.me, e as unknown as Input)
    }),
  )
  on('tool.call', { tool: 'mcp__rp__team_notify' }, ($, e) =>
    safely(async () => {
      const got = await teamOf($, e.agentId)
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
      const why = e.agentId && critics.has(e.agentId) ? `${$.plugin.name}: the critic only reads.` : await outsideZone($, (e as unknown as { file_path: string }).file_path, e.agentId)
      return why ? { deny: why } : next(e)
    }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: the zone guard failed.` }))
  }
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const why = e.agentId && critics.has(e.agentId) ? `${$.plugin.name}: the critic only reads.` : await outsideZone($, (e as unknown as { notebook_path: string }).notebook_path, e.agentId)
    return why ? { deny: why } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${$.plugin.name}: the zone guard failed.` }))
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const why = await bashOutsideZone($, e.command, e.agentId)
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
      const file = pending.get(e.agentId)
      if (file) await $.fs.write(file, e.answer || '(the critic answered nothing)').catch(err => $.ui.log(`${$.plugin.name}: the critic's answer could not be kept: ${String(err)}`))
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
