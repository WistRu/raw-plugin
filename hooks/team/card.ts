// The team's card and briefs as text: what every member reads first. Pure
// functions over the team's data; the six rules every team keeps are here,
// ported from BTC5Model's .scratch/convergence-roles/ROLES.md (2026-10-06)
// with everything project-specific left out.

export type Role = {
  // Short handle, [a-z0-9-]: the inbox folder, the note's name, the address.
  name: string
  // One line: what the role does and owns.
  lane: string
  // Paths (prefixes, relative to the project root) the role may edit; empty
  // means read-only outside the team folder.
  zone: string[]
  // What done looks like for this role.
  deliverable: string
  // Who verifies its results; null when nobody must.
  verifier: string | null
  // The engine's id of the role's session (`$.session.id()` there), written
  // by that session when it binds; absent until then.
  sessionId?: string
  // The desktop app's address of the session (`local_...`), written by the
  // lead when it starts the session: what a message is sent to.
  address?: string
  // An in-process agent id when the role runs as a subagent instead.
  agentId?: string
  // A parked role gets no messages: what is sent to it waits in its inbox
  // until the lead wakes it.
  parked?: boolean
}

export type Team = {
  slug: string
  goal: string
  // The absolute folder the team's files live in.
  dir: string
  // The project root the zones are relative to.
  root: string
  // The lead's session: the engine's id, and the desktop address when known.
  lead: string
  leadAddress?: string
  roles: Role[]
  rules: string[]
  // The model the role sessions are started on, when the lead names one
  // (a cheaper id for mechanical roles); absent = the app's default.
  roleModel?: string
  created: string
  closed?: string
}

export const RULES: readonly string[] = [
  'One owner per zone: a role edits only inside its zone and the team folder; everything else it asks the owner for.',
  'Who does is not who judges: a result with a verifier goes to awaiting_verify, and only the verifier marks it done.',
  'A finding goes straight to the role that acts on it; the lead gets one line at a milestone (a result, a stop, a decision needed).',
  'A figure without a verdict is marked "unverified" wherever it is quoted.',
  'No idle role: every turn ends by starting the next queue item or by writing what it waits on and from whom (team_handoff).',
  'Decisions for the operator go through the lead with at most two options and a recommendation.',
]

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task'

// The first line of a role's brief: what the plugin binds the session by.
export const BRIEF_MARK = /^\[rp team\] team=([a-z0-9а-яё-]+) role=([a-z0-9а-яё-]+) dir=(\S+)/u

export function cardText(team: Team): string {
  const lines = [
    `# Team ${team.slug}`,
    '',
    `Goal: ${team.goal}`,
    `Folder: ${team.dir}`,
    `Created: ${team.created}`,
    '',
    '## Roles',
    '',
    '| role | lane | zone | deliverable | verifier |',
    '|---|---|---|---|---|',
    ...team.roles.map(r => `| ${r.name}${r.parked ? ' (parked)' : ''} | ${r.lane} | ${r.zone.join(', ') || '(read-only)'} | ${r.deliverable} | ${r.verifier ?? '-'} |`),
    '',
    '## Rules',
    '',
    ...team.rules.map((r, i) => `${i + 1}. ${r}`),
    '',
    '## How the team talks',
    '',
    '- The ledger: `mcp__rp__team_task` (add / set / list / board / queue). Statuses: ready, in_progress, awaiting_verify, done, failed, dropped; blocked and ready follow from depends_on.',
    '- A message to a role: `mcp__rp__team_notify` (to its session, or an event file in its inbox when it has none).',
    '- The handoff note: `mcp__rp__team_handoff` writes the queue block of `handoff/<role>.md`; the stamp and the session id are added by the plugin.',
    '- The critic: `mcp__rp__critic_result` reads a result with fresh eyes before it goes to its verifier; a task with a verifier is not sent to awaiting_verify without it.',
    '- Roles (the lead only): `mcp__rp__team_role` parks, wakes, adds or starts a role.',
    '- A shell job that finishes: `sh <team folder>/notify.sh <role> "<what>" [<path>]`.',
    '- Report in one schema: what was done · worked or not · what is needed next.',
  ]
  return lines.join('\n')
}

// The first message of a role's session. Its first line is what the plugin
// binds the session to the team by, before the model reads a word.
export function brief(team: Team, role: Role, firstTask: { id: string; title: string } | undefined): string {
  const task = firstTask ? `Your first task is ${firstTask.id}: ${firstTask.title}.` : 'Your queue is empty: tell the lead so in one line and ask for work.'
  return [
    `[rp team] team=${team.slug} role=${role.name} dir=${team.dir}`,
    '',
    `You are the role "${role.name}" of the team "${team.slug}". Goal of the team: ${team.goal}`,
    `Your lane: ${role.lane}`,
    `Your zone (the only paths you edit): ${role.zone.join(', ') || 'none outside the team folder'}`,
    `Done looks like: ${role.deliverable}`,
    role.verifier ? `Your results are verified by "${role.verifier}": send them with status awaiting_verify.` : 'Nobody verifies your results: mark them done yourself, with the artifact path.',
    '',
    task,
    '',
    `If your instructions show no "Team ${team.slug}" section, the plugin did not bind this session: call mcp__rp__team_join with team "${team.slug}" and role "${role.name}" first.`,
    'Read the card at `' + `${team.dir}/CARD.md` + '` before anything else.',
  ].join('\n')
}

// The system-prompt section a member reads on every request. Static on
// purpose: a section whose text changes between turns throws the prompt
// cache away for the whole conversation. The live queue and board come
// through the tools.
export function memberSection(team: Team, role: Role): string {
  return [
    `# Team ${team.slug} (rp)`,
    `You are the role "${role.name}". Lane: ${role.lane}. Zone: ${role.zone.join(', ') || 'none outside the team folder'}. Deliverable: ${role.deliverable}.${role.verifier ? ` Verifier: ${role.verifier}.` : ''}`,
    `Team folder: ${team.dir} (card CARD.md, ledger tasks.json, your note handoff/${role.name}.md).`,
    'Rules:',
    ...team.rules.map((r, i) => `${i + 1}. ${r}`),
    'Tools: mcp__rp__team_task (the ledger; action "queue" shows your note\'s queue block, "board" the whole team), mcp__rp__team_notify (message a role or "lead"), mcp__rp__team_handoff (write your queue block).',
    'Before a result leaves you: mcp__rp__critic_audit (the mechanical check of figures, commands, files, tests and sums against the record), then mcp__rp__critic_result with the task id (mode "heavy" for a figure or conclusion that reaches the lead or the person), then mcp__rp__critic_answer for each finding with evidence; awaiting_verify is refused while a blocking finding is open. mcp__rp__critic_predict before and after every run whose outcome you will report; mcp__rp__critic_checklist add when a finding settles as a real mistake.',
    'At the start of a turn that begins new work, read your queue (team_task queue). Before a long wait and after every finished item call team_handoff.',
    'Git in your zone: commit by path, `git add <your files>` and `git commit -m "<message>" -- <your files>`; a commit with no paths, `git add -A` or `.`, and git stash/reset/checkout/clean are refused to a role (they reach the whole tree) and are the lead\'s.',
  ].join('\n')
}

export function leadSection(team: Team): string {
  return [
    `# Team ${team.slug} (rp) -- you are the lead`,
    `Goal: ${team.goal}. Team folder: ${team.dir}.`,
    `Roles: ${team.roles.map(r => r.name).join(', ')}.`,
    'You own priorities, the ledger and the operator\'s decisions (at most two options, a recommendation first). You start nothing a role owns; you message the role.',
    'Tools: mcp__rp__team_task (action "board" draws the board with each role\'s state, the errors the critics found and the prediction scores), mcp__rp__team_notify, mcp__rp__team_role (park, wake, add or start a role), mcp__rp__critic_result and critic_answer for your own results, mcp__rp__critic_session at a milestone and before /team close (the critic of this whole session, the person\'s reasoning included; its USER findings go to the person as they stand); /team status draws the board for the person, /team close ends the team.',
    'Only verified figures reach the operator; anything else is marked "unverified".',
  ].join('\n')
}
