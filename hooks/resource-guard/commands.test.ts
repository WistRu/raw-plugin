import { expect, test } from 'claude-code/testing'
import { isLight, segments, signature, stripOldWrapper } from './commands'

test('light commands are file, text and git work, with quick verbs of tools', async () => {
  for (const c of [
    'git status',
    'ls -la /tmp && cat a.txt | grep x',
    'cd /x && git log --oneline | head -5',
    'FOO=1 BAR=2 echo hi; pwd',
    '/usr/bin/git diff',
    'cargo --version',
    'npm ls',
    'python3 --version',
    'bash -c "git status"',
    'claude plugin validate .',
    'sudo systemctl status x',
    'time ls',
    '',
  ]) expect([c, isLight(c)]).toEqual([c, true])
})

test('everything else is heavy', async () => {
  for (const c of [
    './target/release/btc5-sim --days 30',
    'python3 run.py',
    'cargo build --release',
    'cargo run -- --x',
    'npm run build',
    'make -j6',
    'pytest',
    'bash -c "cargo test"',
    'ls && cargo test',
    'cd /x; python3 sim.py',
    'heavy-looking-binary',
    'nice -n 10 python3 train.py',
  ]) expect([c, isLight(c)]).toEqual([c, false])
})

test('segments split on pipes, chains and newlines', async () => {
  expect(segments('a | b && c || d; e & f\ng')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  expect(segments('(cd x && X=1 Y=2 make) 2>&1')).toEqual(['cd x', 'make) 2>', '1'])
})

test('signatures ignore numbers, hashes and quoted strings', async () => {
  expect(signature('cargo run --release -- --days 30 --seed 12345')).toBe('cargo run --release -- --days # --seed #')
  expect(signature("python3 sim.py --name 'run a' --day 2026-10-21")).toBe('python3 sim.py --name " --day #-#-#')
  expect(signature('git checkout 0123abcd4567')).toBe('git checkout #')
  expect(signature('x'.repeat(300)).length).toBe(120)
})

test('the old wrapper word is dropped', async () => {
  expect(stripOldWrapper('heavy cargo run')).toBe('cargo run')
  expect(stripOldWrapper('  heavy ./sim')).toBe('./sim')
  expect(stripOldWrapper('heavyweight x')).toBe('heavyweight x')
})
