import { expect, test } from 'claude-code/testing'

import { writeTargets } from './bashzone'
import { BRIEF_MARK, RULES, brief, cardText, slugify } from './card'
import type { Team } from './card'
import { queueBlock, replaceQueue } from './folder'
import { addTask, board, checkDeps, emptyLedger, setTask } from './ledger'

const AT = '2026-10-21T13:00Z'
const DIR = '/p/.claude/teams/demo'

const team = (): Team => ({
  slug: 'demo', goal: 'Ship the thing', dir: DIR, root: '/p', lead: 'lead-engine-id', created: AT,
  rules: [...RULES],
  roles: [
    { name: 'builder', lane: 'writes the code', zone: ['src'], deliverable: 'a green test', verifier: 'checker', sessionId: 'engine-id' },
    { name: 'checker', lane: 'verifies', zone: [], deliverable: 'a verdict', verifier: null },
  ],
})

const add = (...args: Parameters<typeof addTask>) => {
  const r = addTask(...args)
  if ('error' in r) throw new Error(r.error)
  return r
}

test('the ledger computes blocked and ready, and done wakes the dependents', async () => {
  let l = emptyLedger()
  const a = add(l, { title: 'build', owner: 'builder', verifier: 'checker' }, AT, 'lead')
  l = a.ledger
  const b = add(l, { title: 'check', owner: 'checker', depends_on: [a.task.id] }, AT, 'lead')
  l = b.ledger
  expect(a.task.id).toBe('T-0001')
  expect(b.task.status).toBe('blocked')

  const typed = setTask(l, { id: 'T-0002', status: 'ready' as never }, AT, 'lead')
  expect('error' in typed).toBe(true)

  const early = setTask(l, { id: 'T-0002', status: 'done' }, AT, 'checker')
  expect('error' in early && early.error).toMatch(/waits on T-0001/)

  // a verified task needs the critic before awaiting_verify
  const unread = setTask(l, { id: 'T-0001', status: 'awaiting_verify' }, AT, 'builder')
  expect('error' in unread && unread.error).toMatch(/after the critic/)
  const read = setTask(l, { id: 'T-0001', critic: { at: AT, summary: 'BLOCKING: none' } }, AT, 'builder')
  if ('error' in read) throw new Error(read.error)
  l = read.ledger

  const verify = setTask(l, { id: 'T-0001', status: 'awaiting_verify', artifact: { path: 'out.txt' } }, AT, 'builder')
  if ('error' in verify) throw new Error(verify.error)
  expect(verify.wakes.map(w => `${w.kind}:${w.role}`)).toEqual(['verify:checker'])
  l = verify.ledger

  const done = setTask(l, { id: 'T-0001', status: 'done' }, AT, 'checker')
  if ('error' in done) throw new Error(done.error)
  expect(done.wakes.map(w => `${w.kind}:${w.role}:${w.task}`)).toEqual(['ready:checker:T-0002'])
  l = done.ledger
  expect(l.tasks[1]?.status).toBe('ready')

  const failed = setTask(add(l, { title: 'more', owner: 'builder', depends_on: ['T-0002'] }, AT, 'lead').ledger, { id: 'T-0002', status: 'failed' }, AT, 'checker')
  if ('error' in failed) throw new Error(failed.error)
  expect(failed.wakes.map(w => w.kind)).toEqual(['decide'])
  expect(failed.ledger.tasks[2]?.status).toBe('blocked')

  const text = board(failed.ledger, AT)
  expect(text).toMatch(/1 open task/)
  expect(text).toMatch(/T-0003 \*\*blocked\*\* more -- waits on T-0002/)
})

test('a dependency must exist and may not close a ring', async () => {
  let l = emptyLedger()
  l = add(l, { title: 'a', owner: 'x' }, AT, 'lead').ledger
  l = add(l, { title: 'b', owner: 'x', depends_on: ['T-0001'] }, AT, 'lead').ledger
  expect(checkDeps(l, 'T-0003', ['T-0009'])).toMatch(/no task T-0009/)
  expect(checkDeps(l, 'T-0001', ['T-0001'])).toMatch(/itself/)
  expect(checkDeps(l, 'T-0001', ['T-0002'])).toMatch(/ring/)
  expect(checkDeps(l, 'T-0002', ['T-0001'])).toBeUndefined()
  const unknown = addTask(l, { title: 'c', owner: 'x', depends_on: ['T-0042'] }, AT, 'lead')
  expect('error' in unknown && unknown.error).toMatch(/no task T-0042/)
  const ring = setTask(l, { id: 'T-0001', depends_on: ['T-0002'] }, AT, 'lead')
  expect('error' in ring && ring.error).toMatch(/ring/)
})

test('the card, the brief and the queue block are text the model can read', async () => {
  const t = team()
  const card = cardText(t)
  expect(card).toMatch(/\| builder \| writes the code \| src \| a green test \| checker \|/)
  expect(card).toMatch(/1\. One owner per zone/)
  const b = brief(t, t.roles[0]!, { id: 'T-0001', title: 'build' })
  const first = b.split('\n')[0] ?? ''
  expect(first).toBe(`[rp team] team=demo role=builder dir=${DIR}`)
  const mark = first.match(BRIEF_MARK)
  expect(mark?.slice(1)).toEqual(['demo', 'builder', DIR])
  expect(b).toMatch(/Your first task is T-0001: build\./)
  expect(slugify('Переписать Hub ticket 03!')).toBe('переписать-hub-ticket-03')

  const note = '# builder -- handoff\n\n## Queue (old)\n\n- a\n- b\n\n## Inbox\n- x\n'
  expect(queueBlock(note)).toBe('## Queue (old)\n\n- a\n- b')
  const replaced = replaceQueue(note, 'new; nothing running', '- c')
  expect(replaced).toBe('# builder -- handoff\n\n## Queue (new; nothing running)\n\n- c\n\n## Inbox\n- x\n')
  expect(replaceQueue('# r -- handoff\n\n## Inbox\n', 'h', '- d')).toBe('# r -- handoff\n\n## Queue (h)\n\n- d\n\n## Inbox\n')
})

test('what a Bash command writes is read off its text, quotes honoured', async () => {
  expect(writeTargets('git status && ls src')).toBeUndefined()
  expect(writeTargets('cargo test -p x')).toBeUndefined()
  expect(writeTargets("sed 's/a/b/' src/a.ts | head")).toBeUndefined()
  expect(writeTargets("sed -i 's/a/b/' src/a.ts")).toEqual({ verbs: ['sed'], paths: ['src/a.ts'], isWholeTree: false })
  expect(writeTargets('sed -i s/a/b/ src/a.ts')).toEqual({ verbs: ['sed'], paths: ['src/a.ts'], isWholeTree: false })
  expect(writeTargets('echo hi > out.txt')).toEqual({ verbs: ['>'], paths: ['out.txt'], isWholeTree: false })
  expect(writeTargets('grep -r foo src 2>/dev/null | tee /tmp/x.log')).toEqual({ verbs: ['tee'], paths: ['/tmp/x.log'], isWholeTree: false })
  expect(writeTargets('cp a.txt ../b.txt')).toEqual({ verbs: ['cp'], paths: ['a.txt', '../b.txt'], isWholeTree: false })
  expect(writeTargets('git stash')?.isWholeTree).toBe(true)
  expect(writeTargets('git add -A && git commit -m "x"')?.isWholeTree).toBe(true)
  expect(writeTargets('git add src/a.ts')).toEqual({ verbs: ['git add'], paths: ['src/a.ts'], isWholeTree: false })
  expect(writeTargets('git log --oneline -- src')).toBeUndefined()
  expect(writeTargets('mkdir -p ~/scratch')).toEqual({ verbs: ['mkdir'], paths: ['~/scratch'], isWholeTree: false })
  // the critic's cases: a quoted target, a quoted destination, bash -c, git -C, git add .
  expect(writeTargets('echo x > "other/f.txt"')).toEqual({ verbs: ['>'], paths: ['other/f.txt'], isWholeTree: false })
  expect(writeTargets('cp a.txt "other/zone/f.txt"')).toEqual({ verbs: ['cp'], paths: ['a.txt', 'other/zone/f.txt'], isWholeTree: false })
  expect(writeTargets('bash -c "rm -rf other/"')).toEqual({ verbs: ['rm'], paths: ['other/'], isWholeTree: false })
  expect(writeTargets('git -C /other add .')?.isWholeTree).toBe(true)
  expect(writeTargets('git add .')?.isWholeTree).toBe(true)
  expect(writeTargets("git commit -m 'fix a.ts and b.ts' -- src/a.ts")).toEqual({ verbs: ['git commit'], paths: ['src/a.ts'], isWholeTree: false })
  expect(writeTargets('sudo -u wist tee /etc/x <<< y')).toEqual({ verbs: ['tee'], paths: ['/etc/x'], isWholeTree: false })
  // the critic's second round: bare names after a writing verb, and cd
  expect(writeTargets('rm -rf docs')).toEqual({ verbs: ['rm'], paths: ['docs'], isWholeTree: false })
  expect(writeTargets('touch Makefile')).toEqual({ verbs: ['touch'], paths: ['Makefile'], isWholeTree: false })
  expect(writeTargets('mv src/a.ts docs')).toEqual({ verbs: ['mv'], paths: ['src/a.ts', 'docs'], isWholeTree: false })
  expect(writeTargets('chmod 644 src/a.ts')).toEqual({ verbs: ['chmod'], paths: ['src/a.ts'], isWholeTree: false })
  expect(writeTargets('cd ../elsewhere && touch src/x.ts')).toEqual({ verbs: ['touch'], paths: ['../elsewhere/src/x.ts'], isWholeTree: false })
  expect(writeTargets('cd /tmp; echo x > out.txt')).toEqual({ verbs: ['>'], paths: ['/tmp/out.txt'], isWholeTree: false })
  expect(writeTargets('cd src && git add a.ts')?.isWholeTree).toBe(true)
  expect(writeTargets('dd if=/dev/zero of=/tmp/blob bs=1M count=1')).toEqual({ verbs: ['dd'], paths: ['/dev/zero', '/tmp/blob'], isWholeTree: false })
  // the critic's third round: compound commands, a commit message, /dev/null
  expect(writeTargets('if true; then rm -rf other; fi')).toEqual({ verbs: ['rm'], paths: ['other'], isWholeTree: false })
  expect(writeTargets('( rm -rf other )')).toEqual({ verbs: ['rm'], paths: ['other'], isWholeTree: false })
  expect(writeTargets('echo $(rm -rf other)')).toEqual({ verbs: ['rm'], paths: ['other'], isWholeTree: false })
  expect(writeTargets('x=`rm -rf other`')).toEqual({ verbs: ['rm'], paths: ['other'], isWholeTree: false })
  expect(writeTargets('for f in a b; do touch "$f.txt"; done')).toEqual({ verbs: ['touch'], paths: ['$f.txt'], isWholeTree: false })
  expect(writeTargets('git commit -m "fix things" src/a.ts')).toEqual({ verbs: ['git commit'], paths: ['src/a.ts'], isWholeTree: false })
  expect(writeTargets('git commit -m "fix things"')?.isWholeTree).toBe(true)
  expect(writeTargets('find . -name x 2>/dev/null')).toBeUndefined()
  expect(writeTargets('ls > /dev/null; cat a.md >/dev/stderr')).toBeUndefined()
})

// What the engine answers beneath the plugin. With `bound`, the registry
// names this session as the builder of the demo team and the files are
// there; without, it is a session of no team.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], bound = false, world: { flock?: boolean } = {}) {
  const t = team()
  const files = new Map<string, string>()
  if (bound) files.set(`${DIR}/team.json`, JSON.stringify(t))
  const calls: string[] = []
  const runs: string[][] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__rp__${e.name}` } }))
  on('agent.register', (_, e) => ({ value: { agent: `rp:${e.name}` } }))
  on('tool.list', () => ({ value: [] }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'engine-id' }))
  on('session.cwd', () => ({ value: '/p' }))
  on('session.root', () => ({ value: '/p' }))
  on('session.repo', () => ({ value: bound ? { root: '/p', remote: null, internal: false, repo: null } : null }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.list', () => {
    throw new Error('ENOENT')
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  // every path resolves to itself: no links in this world
  on('fs.stat', (_, e) => ({ value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: e.path.replace(/\/$/, '') } }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    // whether this world has flock decides which lock the test sees
    if (e.argv[0] === 'sh' && String(e.argv[2]).includes('command -v flock'))
      return { value: { exitCode: world.flock ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    // `mv tmp target` is how a JSON file is written: the world keeps it
    if (e.argv[0] === 'mv' && e.argv[1] === '-f') {
      const text = files.get(String(e.argv[2]))
      if (text !== undefined) {
        files.set(String(e.argv[3]), text)
        files.delete(String(e.argv[2]))
      }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('store.get', () => ({ value: bound ? { 'engine-id': { dir: DIR, role: 'builder' } } : undefined }))
  on('store.set', () => ({ value: undefined }))
  on('session.send', () => ({ isDelivered: false, reason: 'test' }))
  on('tool.call', (_, e) => {
    calls.push(e.tool)
    return { result: 'ran', text: 'ran' }
  })
  return { files, calls, runs }
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) => $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })

test('/team status in a session of no team says so', async ($, on) => {
  engine(on)
  await start($)
  const ran = await $.command.run({ command: 'team', args: 'status' })
  expect(ran.text).toMatch(/in no team/)
})

test('team_create refuses a draft it cannot use', async ($, on) => {
  engine(on)
  await start($)
  const none = await $.tool.call({ tool: 'mcp__rp__team_create', goal: 'x', roles: [] } as never)
  expect(none.text).toMatch(/needs a goal and at least one role/)
  const twice = await $.tool.call({ tool: 'mcp__rp__team_create', goal: 'x', roles: [{ name: 'a', lane: '', zone: [], deliverable: '' }, { name: 'a', lane: '', zone: [], deliverable: '' }] } as never)
  expect(twice.text).toMatch(/unique/)
  const orphan = await $.tool.call({ tool: 'mcp__rp__team_create', goal: 'x', roles: [{ name: 'a', lane: '', zone: [], deliverable: '', verifier: 'b' }] } as never)
  expect(orphan.text).toMatch(/Verifier "b" of a is not a role/)
})

test('a member edits inside its zone and its own note, nowhere else', async ($, on) => {
  const { calls } = engine(on, true)
  await start($)
  const edit = (file_path: string) => $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b' })

  expect((await edit('/p/src/a.ts')).deny).toBeUndefined()
  expect((await edit('src/b.ts')).deny).toBeUndefined()
  expect((await edit(`${DIR}/handoff/builder.md`)).deny).toBeUndefined()
  expect((await edit('/p/docs/x.md')).deny).toMatch(/outside the zone of the role "builder"/)
  expect((await edit(`${DIR}/team.json`)).deny).toMatch(/outside the zone/)
  expect((await edit(`${DIR}/tasks.json`)).deny).toMatch(/outside the zone/)
  expect((await $.tool.call({ tool: 'Write', file_path: '/etc/x', content: '' })).deny).toMatch(/outside the zone/)
  expect(calls.filter(c => c === 'Edit').length).toBe(3)

  const bash = (command: string) => $.tool.call({ tool: 'Bash', command })
  expect((await bash('git status')).deny).toBeUndefined()
  expect((await bash("sed -i 's/a/b/' src/a.ts")).deny).toBeUndefined()
  expect((await bash('echo x > /p/docs/out.md')).deny).toMatch(/would write \/p\/docs\/out\.md/)
  expect((await bash('echo x > "/p/docs/out.md"')).deny).toMatch(/would write \/p\/docs\/out\.md/)
  expect((await bash('git stash')).deny).toMatch(/rewrites the tree/)
  expect((await bash('git add -A')).deny).toMatch(/rewrites the tree/)
  expect((await bash('cp src/a.ts ~/a.ts')).deny).toMatch(/would write ~\/a\.ts/)
  expect((await bash('rm -rf docs')).deny).toMatch(/would write docs/)
  expect((await bash('cd ../elsewhere && touch src/x.ts')).deny).toMatch(/would write \.\.\/elsewhere\/src\/x\.ts/)
  expect((await bash('touch src/new.ts')).deny).toBeUndefined()
})

test('with flock, a ledger write holds the lock through the child the stream ends', async ($, on) => {
  engine(on, true, { flock: true })
  const spawns: string[][] = []
  let ended = false
  on('process.spawn', async function* (_, e) {
    spawns.push([...e.argv])
    try {
      yield { stream: 'stdout' as const, text: 'held\n' }
      await new Promise<void>(() => {})
    } finally {
      ended = true
    }
    return { code: null, signal: 'SIGTERM' }
  })
  await start($)
  const added = await $.tool.call({ tool: 'mcp__rp__team_task', action: 'add', title: 'x', owner: 'builder' } as never)
  expect(added.text).toMatch(/^T-0001 ready: x/)
  const hold = spawns.find(a => a[0] === 'sh' && a[3] === 'hold')
  expect(hold?.[4]).toBe(`${DIR}/.flock`)
  expect(hold?.[2]).toMatch(/flock -w "\$2" 9/)
  expect(ended).toBe(true)
})

test('a ledger write takes the folder lock in a process and gives it back (the mkdir lock; the flock one is hooks/team/lock.test.sh)', async ($, on) => {
  const { runs } = engine(on, true)
  await start($)
  const before = runs.length
  const added = await $.tool.call({ tool: 'mcp__rp__team_task', action: 'add', title: 'x', owner: 'builder' } as never)
  expect(added.text).toMatch(/^T-0001 ready: x/)
  const mine = runs.slice(before)
  const lock = mine.find(r => r[0] === 'sh' && r[3] === 'lock')
  expect(lock?.[4]).toBe(`${DIR}/.lock`)
  expect(mine.some(r => r[0] === 'rmdir' && r[1] === `${DIR}/.lock`)).toBe(true)
  expect(mine.some(r => r[0] === 'mv' && String(r[3]).endsWith('/tasks.json'))).toBe(true)
})
