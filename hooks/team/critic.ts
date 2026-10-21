// The critic runs: what a run is, how a critic's reply is parsed into
// findings with statuses, the prompts of the four critics (facts, logic,
// review, debate), the session digest, the predictions and the metrics the
// board shows. Pure over data; spawning and files are index.tsx's.

export type FindingStatus = 'OPEN' | 'SETTLED-FIXED' | 'SETTLED-WRONG' | 'USER'
export type Severity = 'BLOCKING' | 'NOTE' | 'QUESTION'
export type Who = 'USER' | 'AGENT'

export type CriticFinding = {
  id: string
  status: FindingStatus
  severity: Severity
  who: Who
  text: string
  // The role's last answer and the critic's last word on it.
  answer?: string
  verdict?: string
}

export type CriticRun = {
  id: string
  // what was read: one artifact (file or claim), or the whole session
  kind: 'artifact' | 'review'
  subject: string
  role: string
  task?: string
  // light: one critic; heavy: the facts critic and the logic critic
  mode: 'light' | 'heavy'
  round: number
  startedAt: string
  updatedAt: string
  findings: CriticFinding[]
  // the critics' free text of the last round (claims, prior work, breaker)
  notes: string
}

export const MAX_ROUNDS = 3

// One finding per line, as every critic is told to write it:
//   F3 [OPEN] BLOCKING AGENT -- the text
// A reply's other lines are kept as notes.
const LINE = /^\s*-?\s*(F\d+)\s+\[(OPEN|SETTLED-FIXED|SETTLED-WRONG|USER)\]\s+(BLOCKING|NOTE|QUESTION)(?:\s+(USER|AGENT))?\s+--\s+(.*)$/

export function parseFindings(reply: string): { findings: CriticFinding[]; notes: string } {
  const findings: CriticFinding[] = []
  const notes: string[] = []
  for (const line of reply.split('\n')) {
    const m = line.match(LINE)
    if (m) findings.push({ id: m[1] ?? '', status: m[2] as FindingStatus, severity: m[3] as Severity, who: (m[4] as Who | undefined) ?? 'AGENT', text: (m[5] ?? '').trim() })
    else if (line.trim()) notes.push(line)
  }
  return { findings, notes: notes.join('\n') }
}

// Two critics' replies become one list: ids renumbered F1.., the second
// critic's lines after the first's.
export function mergeReplies(replies: string[]): { findings: CriticFinding[]; notes: string } {
  const findings: CriticFinding[] = []
  const notes: string[] = []
  for (const [i, reply] of replies.entries()) {
    const parsed = parseFindings(reply)
    for (const f of parsed.findings) findings.push({ ...f, id: `F${findings.length + 1}` })
    if (parsed.notes) notes.push(replies.length > 1 ? `--- critic ${i + 1} ---\n${parsed.notes}` : parsed.notes)
  }
  return { findings, notes: notes.join('\n') }
}

// After a debate round the critic answers with status lines; a finding it
// does not mention keeps its status, a new id is added.
export function applyVerdicts(run: CriticRun, reply: string): CriticRun {
  const parsed = parseFindings(reply)
  const byId = new Map(run.findings.map(f => [f.id, f]))
  for (const f of parsed.findings) {
    const old = byId.get(f.id)
    if (old) byId.set(f.id, { ...old, status: f.status, severity: f.severity, who: f.who, verdict: f.text })
    else byId.set(f.id, f)
  }
  return { ...run, findings: [...byId.values()], notes: parsed.notes || run.notes, round: run.round + 1 }
}

export const openBlocking = (run: CriticRun): number => run.findings.filter(f => f.status === 'OPEN' && f.severity === 'BLOCKING').length

export function renderRun(run: CriticRun): string {
  const lines = [
    `# Critic run ${run.id} (${run.kind}, ${run.mode}) -- round ${run.round}, ${run.updatedAt}`,
    `subject: ${run.subject}${run.task ? `; task ${run.task}` : ''}; role ${run.role}`,
    `open blocking: ${openBlocking(run)}; findings: ${run.findings.length}`,
    '',
    ...run.findings.map(f => `- ${f.id} [${f.status}] ${f.severity} ${f.who} -- ${f.text}${f.answer ? `\n    answer: ${f.answer}` : ''}${f.verdict ? `\n    critic: ${f.verdict}` : ''}`),
    '',
    run.notes,
  ]
  return lines.join('\n').trim()
}

// ---- Prompts ------------------------------------------------------------------

export const CRITIC_SYSTEM = [
  'You are a critic: a fresh reader with no part in the work you read. You judge nothing and decide nothing; you find where a careful reader would refuse the work, and you say so plainly, with the evidence.',
  'You take nobody\'s word on trust, the author\'s account of its own work included. You read the record: the files, the commands and their outputs. A figure with no source behind it is unsupported until you reproduce it.',
  'You change nothing: no file written, nothing installed, sent or started. In Bash you run only commands that read (cat, head, grep, ls, wc, sha256sum, git log, git diff, git show, python that only prints).',
  'You are specific: the line, the file, the number. No praise, no summary of the work, no advice beyond the finding. If something is fine you do not mention it.',
  'The user reads your replies, so you write them in the language the user wrote in; file paths, commands, code, ids F<n> and the status words stay as they are.',
].join('\n')

export const FINDING_FORMAT = [
  'Write every finding on one line, exactly in this form, nothing else on the line:',
  '  F<n> [OPEN] <BLOCKING|NOTE|QUESTION> <USER|AGENT> -- <what is wrong; the evidence; the checklist line it matches, if one>',
  'BLOCKING: must be fixed or refuted before the work leaves its author. NOTE: worth a line, not a stop. QUESTION: what you could not settle. USER: a mistake in the user\'s premise, framing or request; AGENT: in the author\'s work.',
  'Number findings F1, F2, ... in order of weight. When nothing blocks, write the line "BLOCKING: none" among your notes.',
].join('\n')

const CHECKLIST_CORE = [
  '1. A figure or fact with no tool output or source behind it.',
  '2. A conclusion stronger than its evidence: one case generalised, "always", "proven", "will".',
  '3. A done-claim not checked: "it works", "tests pass", "written", with no run or no file behind it.',
  '4. The author agreed with a premise without checking it, or the premise contradicts the record.',
  '5. A position changed after pushback without new evidence.',
  '6. The question answered is not the question asked; scope drift: things changed that nobody asked for, or something asked for silently dropped.',
  '7. A cheaper, safer or simpler option not considered; only one option shown.',
  '8. A tool error or an odd output ignored.',
  '9. Definitions and units: net or gross, per what, over which period; the same word used for two things.',
  '10. Arithmetic and counting: sums, percentages, averages, off-by-one, a census that cannot see what it counts.',
  '11. Side effects and reversibility: what was changed outside the repository, sent, deleted or started, and does the user know.',
  '12. Prior work ignored: the project\'s own notes, decisions, memory or history already answer or contradict this.',
]

export function factsPrompt(args: { subject: string; purpose: string; audit: string; checklist: string; score: string; userLanguage: string }): string {
  return [
    `Read this result: ${args.subject}`,
    `It is for: ${args.purpose}`,
    'You are the FACTS critic: figures, commands, files, tests, arithmetic, definitions, and whether what is said done was done.',
    '',
    'Step 1 -- claim cards. For every figure or factual claim in the result write a card: CLAIM (the sentence), SOURCE (the file, command or output it rests on, or "none named"), REPRODUCED (yes/no and what you got), FALSIFIER (what would show it wrong and whether it was looked for).',
    'Step 2 -- reproduce. Reproduce at least one figure yourself with a read-only command and compare. A figure that does not reproduce, a command the record never ran, a file the record never wrote: BLOCKING.',
    'Step 3 -- the mechanical audit below was run by a script; confirm or refute each of its lines with what you see.',
    `MECHANICAL AUDIT:\n${args.audit}`,
    'Step 4 -- the checklist. Walk every line against the result:',
    ...CHECKLIST_CORE,
    args.checklist ? `The team\'s own checklist, born from its past mistakes:\n${args.checklist}` : '',
    args.score ? `The author\'s prediction score so far: ${args.score}. Quote it where the author speaks with certainty.` : '',
    '',
    'Reply, in this order and nothing else: CLAIMS (the cards), FINDINGS (the lines below), BREAKER (the single observation that would make the main conclusion wrong, and whether anyone looked for it).',
    FINDING_FORMAT,
    `Write in ${args.userLanguage}.`,
  ].filter(Boolean).join('\n')
}

export function logicPrompt(args: { subject: string; purpose: string; checklist: string; userLanguage: string }): string {
  return [
    `Read this result: ${args.subject}`,
    `It is for: ${args.purpose}`,
    'You are the LOGIC critic: premises, rival explanations, scope, what the conclusion rests on and what it leaves out. Leave the figures to the facts critic; take them as given and ask whether they carry the conclusion.',
    '',
    'Step 1 -- the argument. State the main conclusion and the two or three premises it rests on, each with where the result states it.',
    'Step 2 -- the premises. For each: was it checked against the record or inherited; what rival explanation would fit the same evidence; what is the cheapest check that tells them apart, and was it done.',
    'Step 3 -- the scope. What was asked, what was answered, what was changed that nobody asked for, what was dropped.',
    'Step 4 -- the checklist, the lines about reasoning:',
    ...CHECKLIST_CORE.filter((_, i) => [1, 3, 4, 5, 6, 10, 11].includes(i)),
    args.checklist ? `The team\'s own checklist, born from its past mistakes:\n${args.checklist}` : '',
    '',
    'Reply, in this order and nothing else: ARGUMENT, FINDINGS (the lines below), BREAKER (the single observation that would make the conclusion wrong, and whether anyone looked for it).',
    FINDING_FORMAT,
    `Write in ${args.userLanguage}.`,
  ].filter(Boolean).join('\n')
}

export function reviewPrompt(args: { digestPath: string; cwd: string; git: string; focus: string; checklist: string; priorLedgers: string[]; userLanguage: string }): string {
  return [
    'You are the critic of one whole session of Claude Code, which you did not take part in. Find where the reasoning in it is weak -- the USER\'s as much as the AGENT\'s -- and say so plainly.',
    `TRANSCRIPT DIGEST: ${args.digestPath} (read all of it, in chunks; each entry is tagged M<n>)`,
    `WORKING DIRECTORY: ${args.cwd}`,
    `GIT: ${args.git || 'not a git repository'}`,
    `FOCUS FROM THE USER: ${args.focus || 'none'}`,
    args.priorLedgers.length ? `PRIOR RUNS (read them first; a finding settled before is not raised again without new evidence, one left USER or OPEN is carried over with its old id and its current status): ${args.priorLedgers.join(', ')}` : 'PRIOR RUNS: none -- first run',
    '',
    'Step 1 -- map the session. List the 3-7 main claims, decisions and conclusions, each with its M<n> and who made it (USER or AGENT). A claim the user stated as fact counts the same as one the agent stated.',
    'Step 2 -- verify. For the most important claims: does a tool result in the digest support it (quote the M<n>); re-derive at least one key figure yourself from the source; if the agent says something was done, check the file or the diff now.',
    'Step 3 -- prior work. Look for what was already known or done on this topic and was not used: the project\'s instruction files, docs, memory folder, git log. Say whether the session repeats, contradicts or ignores it.',
    'Step 4 -- the checklist:',
    ...CHECKLIST_CORE,
    '13. The context was compacted and later work relies on details lost in it.',
    args.checklist ? `The team\'s own checklist, born from its past mistakes:\n${args.checklist}` : '',
    'Step 5 -- the breaker. Name the single observation that would make the session\'s main conclusion wrong, and whether anyone looked for it.',
    '',
    'Reply, in this order and nothing else: MAIN CLAIMS (numbered, each with M<n> and USER/AGENT), FINDINGS (the lines below), PRIOR WORK, BREAKER, QUESTIONS FOR THE USER (one line each).',
    FINDING_FORMAT,
    `Write in ${args.userLanguage}.`,
  ].filter(Boolean).join('\n')
}

export function debatePrompt(run: CriticRun, answers: { id: string; status: string; evidence: string }[], userLanguage: string): string {
  const ledger = run.findings.map(f => `${f.id} [${f.status}] ${f.severity} ${f.who} -- ${f.text}`).join('\n')
  const answered = answers.map(a => `${a.id}: ${a.status} -- ${a.evidence}`).join('\n')
  return [
    `You are the critic of a ${run.kind === 'review' ? 'session' : 'result'} (${run.subject}), round ${run.round + 1} of ${MAX_ROUNDS}. Your findings so far:`,
    ledger,
    '',
    'The author answers each one below. For each answer check its evidence yourself (open the file, run the read-only command), then set the status:',
    '  [SETTLED-FIXED] the author fixed it and you verified the fix; [SETTLED-WRONG] the evidence shows your finding was wrong, say so; [USER] it needs the user\'s decision; [OPEN] not settled, say exactly what evidence would settle it.',
    'Do not concede to an argument without evidence, and do not hold a finding the evidence has refuted. You may add a new finding (next free id) if an answer reveals one.',
    'ANSWERS:',
    answered,
    '',
    'Reply with the full ledger, one line per finding in this exact form (the text after -- is your verdict on it, one sentence), then one line on what changed:',
    '  F<n> [<status>] <BLOCKING|NOTE|QUESTION> <USER|AGENT> -- <verdict>',
    `Write in ${userLanguage}.`,
  ].join('\n')
}

// ---- The session digest ----------------------------------------------------------

export type DigestMessage = { role: string; text: string; toolUses?: { tool: string; input: Record<string, unknown>; text?: string; isError?: true }[] }

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)} …[${s.length - n} more chars]`)

// The transcript as plain text the critic reads: one entry per message,
// tool calls with a clipped input and output, each tagged M<n>.
export function digest(messages: DigestMessage[], maxChars = 400_000): string {
  const lines: string[] = []
  let n = 0
  for (const m of messages) {
    n += 1
    const who = m.role === 'user' ? 'USER' : m.role === 'assistant' ? 'AGENT' : m.role.toUpperCase()
    if (m.text.trim()) lines.push(`M${n} ${who}: ${clip(m.text.trim(), 3000)}`)
    for (const t of m.toolUses ?? []) {
      const input = clip(JSON.stringify(t.input), 400)
      lines.push(`M${n} TOOL ${t.tool}${t.isError ? ' (error)' : ''} ${input}\n    -> ${clip((t.text ?? '').trim(), 800).replace(/\n/g, '\n    ')}`)
    }
  }
  let text = lines.join('\n')
  // too long: the older half is clipped harder, newest entries kept whole
  while (text.length > maxChars && lines.length > 10) {
    const cut = Math.floor(lines.length / 3)
    for (let i = 0; i < cut; i++) lines[i] = clip(lines[i] ?? '', 300)
    text = lines.join('\n')
    if (lines.slice(0, cut).every(l => l.length <= 320)) {
      lines.splice(0, cut, `… ${cut} older entries dropped for size …`)
      text = lines.join('\n')
    }
  }
  return text
}

// ---- Predictions ----------------------------------------------------------------

export type Prediction = { id: string; role: string; text: string; task?: string; at: string; outcome?: 'hit' | 'miss' | 'partial'; note?: string }

export function predictionScore(list: Prediction[], role: string): { hits: number; partial: number; total: number } {
  const mine = list.filter(p => p.role === role && p.outcome)
  return { hits: mine.filter(p => p.outcome === 'hit').length, partial: mine.filter(p => p.outcome === 'partial').length, total: mine.length }
}

export const scoreText = (s: { hits: number; partial: number; total: number }) => (s.total ? `${s.hits} hit, ${s.partial} partial of ${s.total} resolved` : 'no resolved predictions')

// ---- Metrics ---------------------------------------------------------------------

export type RoleMetrics = { role: string; runs: number; blocking: number; fixed: number; wrong: number; open: number; user: number }

export function metrics(runs: CriticRun[]): RoleMetrics[] {
  const by = new Map<string, RoleMetrics>()
  for (const r of runs) {
    const m = by.get(r.role) ?? { role: r.role, runs: 0, blocking: 0, fixed: 0, wrong: 0, open: 0, user: 0 }
    m.runs += 1
    for (const f of r.findings) {
      if (f.severity === 'BLOCKING') m.blocking += 1
      if (f.status === 'SETTLED-FIXED') m.fixed += 1
      if (f.status === 'SETTLED-WRONG') m.wrong += 1
      if (f.status === 'OPEN') m.open += 1
      if (f.status === 'USER') m.user += 1
    }
    by.set(r.role, m)
  }
  return [...by.values()].sort((a, b) => a.role.localeCompare(b.role))
}

export const metricsLine = (m: RoleMetrics) =>
  `${m.role}: ${m.runs} critic run(s), ${m.blocking} blocking found; ${m.fixed} fixed, ${m.wrong} critic was wrong, ${m.open} open, ${m.user} for the user`
