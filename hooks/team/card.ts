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
  // The role's session id once started; absent until then.
  sessionId?: string
  // An in-process agent id when the role runs as a subagent instead.
  agentId?: string
  // A parked role gets no wake-ups until the lead addresses it.
  active: boolean
}

export type Team = {
  slug: string
  goal: string
  // The absolute folder the team's files live in.
  dir: string
  // The project root the zones are relative to.
  root: string
  // The lead's session id: the session that created the team.
  lead: string
  roles: Role[]
  rules: string[]
  created: string
  closed?: string
}

export const RULES: readonly string[] = [
  'One owner per zone: a role edits only inside its zone and the team folder; everything else it asks the owner for.',
  'Who does is not who judges: a result with a verifier goes to awaiting_verify, and only the verifier marks it done.',
  'A finding goes straight to the role that acts on it; the lead gets one line at a milestone (a result, a stop, a decision needed).',
  'A figure without a verdict is marked "не проверено" wherever it is quoted.',
  'No idle role: every turn ends by starting the next queue item or by writing what it waits on and from whom (team_handoff).',
  'Decisions for the operator go through the lead with at most two options and a recommendation.',
]

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'task'

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
    ...team.roles.map(r => `| ${r.name} | ${r.lane} | ${r.zone.join(', ') || '(read-only)'} | ${r.deliverable} | ${r.verifier ?? '-'} |`),
    '',
    '## Rules',
    '',
    ...team.rules.map((r, i) => `${i + 1}. ${r}`),
    '',
    '## How the team talks',
    '',
    '- The ledger: `mcp__rp__team_task` (add / set / list / board). Statuses: ready, in_progress, awaiting_verify, done, failed, dropped; blocked and ready follow from depends_on.',
    '- A message to a role: `mcp__rp__team_notify` (an event file in its inbox, and a message to its session when it has one).',
    '- The handoff note: `mcp__rp__team_handoff` writes the queue block of `handoff/<role>.md`; the stamp and the session id are added by the plugin.',
    '- A shell job that finishes: `sh <team folder>/notify.sh <role> "<what>" [<path>]`.',
    '- Report in one schema: what was done · worked or not · what is needed next.',
  ]
  return lines.join('\n')
}

// The first message of a role's session: enough to start without the card
// in context, since the plugin adds the card to the system prompt once the
// session is in the roster.
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
    `If the plugin rp did not recognise this session as a member (no "Team" section in your instructions), call mcp__rp__team_join with team "${team.slug}" and role "${role.name}" first.`,
    'Read the card at `' + `${team.dir}/CARD.md` + '` before anything else.',
  ].join('\n')
}

// The system-prompt section a member reads on every request.
export function memberSection(team: Team, role: Role, queue: string): string {
  return [
    `# Team ${team.slug} (rp)`,
    `You are the role "${role.name}". Lane: ${role.lane}. Zone: ${role.zone.join(', ') || 'none outside the team folder'}. Deliverable: ${role.deliverable}.${role.verifier ? ` Verifier: ${role.verifier}.` : ''}`,
    `Team folder: ${team.dir} (card CARD.md, ledger tasks.json, your note handoff/${role.name}.md).`,
    'Rules:',
    ...team.rules.map((r, i) => `${i + 1}. ${r}`),
    'Tools: mcp__rp__team_task (ledger), mcp__rp__team_notify (message a role), mcp__rp__team_handoff (your note), mcp__rp__team_status (the board).',
    'Before a long wait and after every finished item call team_handoff. When your context passes 60 % and you stand between two queue items, call team_handoff and then /compact.',
    queue ? `Your note's queue block now:\n${queue}` : 'Your note has no queue block yet.',
  ].join('\n')
}

export function leadSection(team: Team, boardText: string): string {
  return [
    `# Team ${team.slug} (rp) -- you are the lead`,
    `Goal: ${team.goal}. Team folder: ${team.dir}.`,
    `Roles: ${team.roles.map(r => `${r.name}${r.sessionId ? '' : ' (not started)'}`).join(', ')}.`,
    'You own priorities, the ledger and the operator\'s decisions (at most two options, a recommendation first). You start nothing a role owns; you message the role.',
    'Tools: mcp__rp__team_task, mcp__rp__team_notify, mcp__rp__team_status; /team status draws the board, /team close ends the team.',
    'Only verified figures reach the operator; anything else is marked "не проверено".',
    boardText,
  ].join('\n')
}
