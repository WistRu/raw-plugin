import { expect, test } from 'claude-code/testing'

import { auditArithmetic, auditCommands, auditDone, auditFigures, claimedCommands, doneClaims, figures, renderFindings } from './audit'
import type { CriticRun } from './critic'
import { applyVerdicts, digest, mergeReplies, metrics, openBlocking, parseFindings, predictionScore } from './critic'

test('figures are pulled out of prose, not out of ids, dates, paths or years', async () => {
  const text = 'Net 1,234.5 USDC over 318 slots (T-0042, 2026-10-21T13:00Z, v2.1.304, `src/a.ts:17`, docs/x.md 2019). Share 0.37; 7 slots lost.'
  expect(figures(text).sort()).toEqual(['0.37', '1234.5', '318'].sort())
})

test('the audit names a figure no tool output carries, and a quoted command never run', async () => {
  const evidence = { toolTexts: ['slots: 318\nnet: 1234.5'], commands: ['uv run pytest -q', 'git status'] }
  const ok = auditFigures('318 slots, net 1,234.5', evidence)
  expect(ok).toEqual([])
  const bad = auditFigures('318 slots, net 1,234.5, 42 wins', evidence)
  expect(bad.map(f => f.text)).toEqual(['the figure 42 appears in no tool output of this session'])
  expect(claimedCommands('ran `uv run pytest -q` and `cargo test -p x`; see `notes.md`')).toEqual(['uv run pytest -q', 'cargo test -p x'])
  expect(auditCommands('ran `cargo test -p x`', evidence).map(f => f.kind)).toEqual(['command'])
  expect(auditCommands('ran `uv run pytest -q`', evidence)).toEqual([])
})

test('done-claims need their proof: a passing run, a git commit, a written file', async () => {
  expect(doneClaims('I wrote `docs/plan.md` and updated src/x.ts; tests passed; committed as abc1234.')).toEqual({ files: ['docs/plan.md', 'src/x.ts'], tests: true, commits: true })
  expect(doneClaims('Тесты прошли, записал отчёт в out/report.md.').files).toEqual(['out/report.md'])
  const noProof = auditDone('tests passed; committed abc1234', { toolTexts: ['3 failed, 20 passed'], commands: ['git status'] })
  expect(noProof.map(f => f.kind).sort()).toEqual(['commit', 'commit', 'tests'])
  const proof = auditDone('tests passed; committed abc1234', { toolTexts: ['23 passed in 1.2s', 'abc1234 fix: x'], commands: ['git commit -m x'] })
  expect(proof).toEqual([])
  // an old green run does not cover a newer red one
  const stale = auditDone('tests passed', { toolTexts: ['23 passed in 1.2s', 'edited', '1 failed, 22 passed'], commands: [] })
  expect(stale.map(f => f.text)).toEqual(['the result says the tests pass, but the newest test output of this session shows failures'])
  // a commit hash the record never showed
  const ghost = auditDone('committed deadbeef1', { toolTexts: ['[main 5c515a9] x'], commands: ['git commit -q -F msg'] })
  expect(ghost.map(f => f.text)).toEqual(['the commit deadbeef1 appears in no tool output of this session (no git log or commit line shows it)'])
})

test('arithmetic lines are recomputed', async () => {
  expect(auditArithmetic('12 + 30 = 42; 100 - 1 = 99; 7 of 20 = 35 %')).toEqual([])
  const bad = auditArithmetic('12 + 31 = 42 and 7 of 20 = 40 %')
  expect(bad.map(f => f.text)).toEqual(['"12 + 31 = 42" does not add up: 12 + 31 = 43', '"7 of 20 = 40 %": 7 of 20 is 35.0 %, not 40 %'])
  expect(renderFindings([])).toMatch(/nothing to report/)
  expect(renderFindings(bad)).toMatch(/^AUDIT: 2 blocking, 0 note/)
})

test('a critic reply becomes findings with statuses; a debate round updates them', async () => {
  const reply = 'CLAIMS\n- x\nFINDINGS\nF1 [OPEN] BLOCKING AGENT -- the figure 42 has no source\n  F2 [OPEN] NOTE USER -- the premise assumes a quiet day\nBREAKER: none looked\n'
  const parsed = parseFindings(reply)
  expect(parsed.findings.map(f => `${f.id}/${f.status}/${f.severity}/${f.who}`)).toEqual(['F1/OPEN/BLOCKING/AGENT', 'F2/OPEN/NOTE/USER'])
  expect(parsed.notes).toMatch(/BREAKER/)
  const merged = mergeReplies([reply, 'F1 [OPEN] QUESTION -- what about fees'])
  expect(merged.findings.map(f => f.id)).toEqual(['F1', 'F2', 'F3'])
  expect(merged.findings[2]?.who).toBe('AGENT')

  const run: CriticRun = { id: 'R1', kind: 'artifact', subject: 'x', role: 'builder', mode: 'light', round: 1, startedAt: 'a', updatedAt: 'a', findings: merged.findings, notes: '' }
  expect(openBlocking(run)).toBe(1)
  const next = applyVerdicts(run, 'F1 [SETTLED-FIXED] BLOCKING AGENT -- the source is now named\nF4 [OPEN] BLOCKING AGENT -- new one\nchanged: F1 closed')
  expect(next.round).toBe(2)
  expect(next.findings.find(f => f.id === 'F1')?.status).toBe('SETTLED-FIXED')
  expect(next.findings.find(f => f.id === 'F1')?.verdict).toBe('the source is now named')
  expect(next.findings.find(f => f.id === 'F2')?.status).toBe('OPEN')
  expect(openBlocking(next)).toBe(1)
  const m = metrics([next])
  expect(m).toEqual([{ role: 'builder', runs: 1, blocking: 2, fixed: 1, wrong: 0, open: 3, user: 0 }])
})

test('the digest tags entries and clips tool output; predictions score per role', async () => {
  const d = digest([
    { role: 'user', text: 'do x' },
    { role: 'assistant', text: 'done', toolUses: [{ tool: 'Bash', input: { command: 'ls' }, text: 'a\nb' }] },
  ])
  expect(d).toBe('M1 USER: do x\nM2 AGENT: done\nM2 TOOL Bash {"command":"ls"}\n    -> a\n    b')
  const long = digest([{ role: 'user', text: 'x'.repeat(5000) }])
  expect(long).toMatch(/…\[2000 more chars\]$/)
  const score = predictionScore([
    { id: 'P-0001', role: 'a', text: 't', at: 'x', outcome: 'hit' },
    { id: 'P-0002', role: 'a', text: 't', at: 'x', outcome: 'miss' },
    { id: 'P-0003', role: 'a', text: 't', at: 'x' },
    { id: 'P-0004', role: 'b', text: 't', at: 'x', outcome: 'partial' },
  ], 'a')
  expect(score).toEqual({ hits: 1, partial: 0, total: 2 })
})
