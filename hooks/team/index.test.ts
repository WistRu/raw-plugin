import { expect, test } from 'claude-code/testing'

import { RULES, brief, cardText, slugify } from './card'
import type { Team } from './card'
import { queueBlock, replaceQueue } from './folder'
import { addTask, board, emptyLedger, setTask } from './ledger'

const AT = '2026-10-21T13:00Z'

const team = (): Team => ({
  slug: 'demo', goal: 'Ship the thing', dir: '/p/.claude/teams/demo', root: '/p', lead: 'local_lead', created: AT,
  rules: [...RULES],
  roles: [
    { name: 'builder', lane: 'writes the code', zone: ['src'], deliverable: 'a green test', verifier: 'checker', active: true },
    { name: 'checker', lane: 'verifies', zone: [], deliverable: 'a verdict', verifier: null, active: true },
  ],
})

test('the ledger computes blocked and ready, and done wakes the dependents', async () => {
  let l = emptyLedger()
  const a = addTask(l, { title: 'build', owner: 'builder', verifier: 'checker' }, AT, 'lead')
  l = a.ledger
  const b = addTask(l, { title: 'check', owner: 'checker', depends_on: [a.task.id] }, AT, 'lead')
  l = b.ledger
  expect(a.task.id).toBe('T-0001')
  expect(b.task.status).toBe('blocked')

  const typed = setTask(l, { id: 'T-0002', status: 'ready' as never }, AT, 'lead')
  expect('error' in typed).toBe(true)

  const early = setTask(l, { id: 'T-0002', status: 'done' }, AT, 'checker')
  expect('error' in early && early.error).toMatch(/waits on T-0001/)

  const verify = setTask(l, { id: 'T-0001', status: 'awaiting_verify', artifact: { path: 'out.txt' } }, AT, 'builder')
  if ('error' in verify) throw new Error(verify.error)
  expect(verify.wakes.map(w => `${w.kind}:${w.role}`)).toEqual(['verify:checker'])
  l = verify.ledger

  const done = setTask(l, { id: 'T-0001', status: 'done' }, AT, 'checker')
  if ('error' in done) throw new Error(done.error)
  expect(done.wakes.map(w => `${w.kind}:${w.role}:${w.task}`)).toEqual(['ready:checker:T-0002'])
  l = done.ledger
  expect(l.tasks[1]?.status).toBe('ready')

  const failed = setTask(addTask(l, { title: 'more', owner: 'builder', depends_on: ['T-0002'] }, AT, 'lead').ledger, { id: 'T-0002', status: 'failed' }, AT, 'checker')
  if ('error' in failed) throw new Error(failed.error)
  expect(failed.wakes.map(w => w.kind)).toEqual(['decide'])
  expect(failed.ledger.tasks[2]?.status).toBe('blocked')

  const text = board(failed.ledger, AT)
  expect(text).toMatch(/1 open task/)
  expect(text).toMatch(/T-0003 \*\*blocked\*\* more -- waits on T-0002/)
})

test('the card, the brief and the queue block are text the model can read', async () => {
  const t = team()
  const card = cardText(t)
  expect(card).toMatch(/\| builder \| writes the code \| src \| a green test \| checker \|/)
  expect(card).toMatch(/1\. One owner per zone/)
  const b = brief(t, t.roles[0]!, { id: 'T-0001', title: 'build' })
  expect(b.split('\n')[0]).toBe('[rp team] team=demo role=builder dir=/p/.claude/teams/demo')
  expect(b).toMatch(/Your first task is T-0001: build\./)
  expect(slugify('Переписать Hub ticket 03!')).toBe('переписать-hub-ticket-03')

  const note = '# builder -- handoff\n\n## Queue (old)\n\n- a\n- b\n\n## Inbox\n- x\n'
  expect(queueBlock(note)).toBe('## Queue (old)\n\n- a\n- b')
  const replaced = replaceQueue(note, 'new; nothing running', '- c')
  expect(replaced).toBe('# builder -- handoff\n\n## Queue (new; nothing running)\n\n- c\n\n## Inbox\n- x\n')
  expect(replaceQueue('# r -- handoff\n\n## Inbox\n', 'h', '- d')).toBe('# r -- handoff\n\n## Queue (h)\n\n- d\n\n## Inbox\n')
})

test('/team status in a session of no team says so', async ($, on) => {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__rp__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'local_me' }))
  on('session.root', () => ({ value: '/p' }))
  on('session.repo', () => ({ value: null }))
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.list', () => {
    throw new Error('ENOENT')
  })
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', () => ({ value: undefined }))

  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ command: 'team', args: 'status' })
  expect(ran.text).toMatch(/in no team/)
})
