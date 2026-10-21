// The mechanical audit of a result against the session's record: no model,
// no judgement, only what a script can check. Every figure in the result
// should appear in some tool output; every "ran", "wrote", "committed" or
// "tests passed" should have its tool call; every arithmetic line should
// add up. Pure over text; the file-system half is in index.tsx.

export type Evidence = {
  // Every tool result's text, as the model read it.
  toolTexts: string[]
  // Every Bash command the session ran.
  commands: string[]
  // Every path a Write, Edit, MultiEdit or NotebookEdit call named: where a
  // relative path in the result may really be, when the session wrote
  // outside its own directory.
  writtenPaths?: string[]
}

export type Finding = { kind: 'figure' | 'command' | 'file' | 'tests' | 'commit' | 'arithmetic' | 'path'; severity: 'blocking' | 'note'; text: string }

const MAX_PER_KIND = 20

const normalize = (s: string) => s.replace(/(\d)[ ,](?=\d{3}\b)/g, '$1').replace(/\s+/g, ' ')

// Numbers worth checking: two or more significant digits, or a decimal, or
// a thousands-grouped figure. Years, ids (T-0001), paths and version-like
// tokens are left out.
export function figures(text: string): string[] {
  const out = new Set<string>()
  const cleaned = text
    .replace(/`[^`\n]*`/g, ' ') // inline code: paths, ids, commands
    .replace(/\S*\/\S*/g, ' ') // paths and urls
    .replace(/\b[A-Z]+-\d+\b/g, ' ') // T-0001, F12
    .replace(/\b\d{4}-\d{2}-\d{2}[T\d:.Z]*\b/g, ' ') // dates and stamps
    .replace(/\b\d+(?:\.\d+){2,}\b/g, ' ') // versions 2.1.304
    .replace(/\b(19|20)\d{2}\b/g, ' ') // years
  for (const m of cleaned.matchAll(/(?<![\w.])[-+]?\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?|(?<![\w.])\d+\.\d+|(?<![\w.-])\d{2,}(?![\w.])/g)) {
    const n = normalize(m[0]).replace(/^[+]/, '')
    if (n.replace(/[-.]/g, '').length >= 2) out.add(n)
  }
  return [...out]
}

export function auditFigures(result: string, evidence: Evidence): Finding[] {
  const haystack = normalize(evidence.toolTexts.join('\n'))
  const missing = figures(result).filter(f => !haystack.includes(f.replace(/^-/, '')))
  return missing.slice(0, MAX_PER_KIND).map(f => ({ kind: 'figure', severity: 'blocking', text: `the figure ${f} appears in no tool output of this session` }))
}

// Commands the result says were run: inline code that starts with a verb.
const COMMAND_START = /^(python3?|uv|cargo|npm|pnpm|yarn|npx|node|bun|make|pytest|go|git|bash|sh|docker|rustc|ruff|mypy|tsc|claude|curl|ssh|scp|rsync|systemctl|sha256sum|grep|rg|find|ls|cat|wc)\b/

export function claimedCommands(result: string): string[] {
  const out = new Set<string>()
  for (const m of result.matchAll(/`([^`\n]{3,200})`/g)) {
    const c = (m[1] ?? '').trim()
    if (COMMAND_START.test(c)) out.add(c)
  }
  for (const m of result.matchAll(/```(?:bash|sh|shell|console)?\n([\s\S]*?)```/g)) {
    for (const line of (m[1] ?? '').split('\n')) {
      const c = line.replace(/^\$\s*/, '').trim()
      if (COMMAND_START.test(c)) out.add(c)
    }
  }
  return [...out]
}

const squeeze = (s: string) => s.replace(/\s+/g, ' ').trim()

export function auditCommands(result: string, evidence: Evidence): Finding[] {
  const ran = evidence.commands.map(squeeze)
  const missing = claimedCommands(result).filter(c => {
    const s = squeeze(c)
    return !ran.some(r => r.includes(s) || s.includes(r))
  })
  return missing.slice(0, MAX_PER_KIND).map(c => ({ kind: 'command', severity: 'note', text: `the command \`${c}\` is quoted but no Bash call of this session ran it` }))
}

// Words that claim a thing was done, in the two languages the operator uses.
// `\b` knows no Cyrillic: the edges are letter lookarounds instead.
const DONE_FILE = /(?<!\p{L})(wrote|written|created|saved|updated|edited|generated|записал[аи]?|создал[аи]?|сохранил[аи]?|обновил[аи]?|отредактировал[аи]?)(?!\p{L})/iu
const DONE_TESTS = /(?<!\p{L})(tests?\s+(are\s+)?(pass(ed|ing)?|green)|all\s+(tests\s+)?pass(ed)?|\d+\s+pass(ed)?,?\s+0\s+fail|тесты?\s+(прош[её]л|прошли|зел[её]ны[ей])|все\s+тесты\s+прошли)(?!\p{L})/iu
const DONE_COMMIT = /(?<!\p{L})(committed|commit\s+[0-9a-f]{6,}|закоммитил[аи]?|коммит\s+[0-9a-f]{6,})(?!\p{L})/iu

export function claimedPaths(line: string): string[] {
  const out = new Set<string>()
  for (const m of line.matchAll(/`([^`\s]+)`|(?<![\w@])((?:~|\.{1,2})?\/[\w./@-]+|[\w.-]+\/[\w./-]+|[\w-]+\.(?:md|ts|tsx|js|py|rs|json|toml|yaml|yml|txt|csv|sh|html|css|sql|lock))(?![\w/])/g)) {
    const p = (m[1] ?? m[2] ?? '').replace(/[.,;:)]+$/, '')
    if (p && !/^https?:/.test(p) && !/^[\d.]+$/.test(p) && !/[<>*?]/.test(p)) out.add(p)
  }
  return [...out]
}

export type DoneClaims = { files: string[]; tests: boolean; commits: boolean }

// What the result says was done, for the checks that need the file system
// or the transcript.
export function doneClaims(result: string): DoneClaims {
  const files = new Set<string>()
  let tests = false
  let commits = false
  for (const line of result.split('\n')) {
    if (DONE_FILE.test(line)) for (const p of claimedPaths(line)) files.add(p)
    if (DONE_TESTS.test(line)) tests = true
    if (DONE_COMMIT.test(line)) commits = true
  }
  return { files: [...files], tests, commits }
}

const PASS = /\b(\d+)\s+(pass(ed|ing)?|passed)\b|\bok\b.*\b\d+\s+passed|\d+\s+tests?\s+(passed|ok)/i
const FAIL = /\b([1-9]\d*)\s+(fail(ed|ing|ures?)?|error(s)?)\b|FAILED|Traceback|panicked/
const RAN = /\bRan \d+ tests?\b|\btest result:|\d+ passed|\d+ pass\b|\d+ fail(ed)?\b/i

// "Tests pass" is proved by the NEWEST test output of the session, not by
// any green one; "committed <hash>" by that hash in some output.
export function auditDone(result: string, evidence: Evidence): Finding[] {
  const out: Finding[] = []
  const claims = doneClaims(result)
  if (claims.tests) {
    const newest = [...evidence.toolTexts].reverse().find(t => RAN.test(t) || PASS.test(t) || FAIL.test(t))
    if (!newest) out.push({ kind: 'tests', severity: 'blocking', text: 'the result says the tests pass, but no tool output of this session shows a test run' })
    else if (FAIL.test(newest)) out.push({ kind: 'tests', severity: 'blocking', text: 'the result says the tests pass, but the newest test output of this session shows failures' })
    else if (!PASS.test(newest) && !/\bRan \d+ tests?\b/i.test(newest)) out.push({ kind: 'tests', severity: 'note', text: 'the newest test output of this session names no passing count; the claim rests on it' })
  }
  if (claims.commits) {
    if (!evidence.commands.some(c => /\bgit\s+commit\b/.test(c)))
      out.push({ kind: 'commit', severity: 'blocking', text: 'the result says something was committed, but no Bash call of this session ran git commit' })
    const hashes = [...result.matchAll(/(?<![\w/])([0-9a-f]{7,40})(?![\w/])/g)].map(m => m[1] ?? '').filter(h => /[a-f]/.test(h) && /\d/.test(h))
    const all = evidence.toolTexts.join('\n')
    for (const h of [...new Set(hashes)].slice(0, 5)) {
      if (!all.includes(h)) out.push({ kind: 'commit', severity: 'blocking', text: `the commit ${h} appears in no tool output of this session (no git log or commit line shows it)` })
    }
  }
  return out
}

// `a op b = c` and `a of b = p %`, each recomputed.
export function auditArithmetic(result: string): Finding[] {
  const out: Finding[] = []
  const num = (s: string) => Number(normalize(s).replace(',', '.'))
  const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.011, Math.abs(b) * 0.006)
  for (const m of result.matchAll(/(-?\d[\d ,]*(?:[.,]\d+)?)\s*([+\-×x*/÷])\s*(-?\d[\d ,]*(?:[.,]\d+)?)\s*=\s*(-?\d[\d ,]*(?:[.,]\d+)?)/g)) {
    const [whole, a, op, b, c] = m
    const x = num(a ?? ''), y = num(b ?? ''), z = num(c ?? '')
    if ([x, y, z].some(Number.isNaN)) continue
    const got = op === '+' ? x + y : op === '-' ? x - y : op === '/' || op === '÷' ? (y === 0 ? NaN : x / y) : x * y
    if (!Number.isNaN(got) && !close(got, z)) out.push({ kind: 'arithmetic', severity: 'blocking', text: `"${squeeze(whole ?? '')}" does not add up: ${x} ${op} ${y} = ${Number(got.toFixed(4))}` })
  }
  for (const m of result.matchAll(/(\d[\d ,]*(?:[.,]\d+)?)\s*(?:of|out of|из)\s*(\d[\d ,]*(?:[.,]\d+)?)\s*(?:=|is|это|—|–|-|\()\s*(\d+(?:[.,]\d+)?)\s*%/g)) {
    const [whole, a, b, p] = m
    const x = num(a ?? ''), y = num(b ?? ''), z = num(p ?? '')
    if ([x, y, z].some(Number.isNaN) || y === 0) continue
    const got = (x / y) * 100
    if (Math.abs(got - z) > Math.max(0.6, Math.abs(z) * 0.02)) out.push({ kind: 'arithmetic', severity: 'blocking', text: `"${squeeze(whole ?? '')}": ${x} of ${y} is ${got.toFixed(1)} %, not ${z} %` })
  }
  return out.slice(0, MAX_PER_KIND)
}

export function auditText(result: string, evidence: Evidence): Finding[] {
  return [...auditFigures(result, evidence), ...auditCommands(result, evidence), ...auditDone(result, evidence), ...auditArithmetic(result)]
}

// What the audit does not see, said every time so a clean report is read
// for what it is.
export const AUDIT_SCOPE = 'Not checked: figures of one digit, words without numbers, whether a figure found in an output means what the result says, anything outside this session\'s record.'

export function renderFindings(findings: Finding[], fileFindings: Finding[] = []): string {
  const all = [...findings, ...fileFindings]
  if (all.length === 0) return `AUDIT: nothing to report (every figure of two or more digits, quoted command, file said written, test claim and sum checked out against the record). ${AUDIT_SCOPE}`
  const blocking = all.filter(f => f.severity === 'blocking')
  const notes = all.filter(f => f.severity === 'note')
  return [
    `AUDIT: ${blocking.length} blocking, ${notes.length} note(s).`,
    ...blocking.map((f, i) => `B${i + 1} [${f.kind}] ${f.text}`),
    ...notes.map((f, i) => `N${i + 1} [${f.kind}] ${f.text}`),
    AUDIT_SCOPE,
  ].join('\n')
}
