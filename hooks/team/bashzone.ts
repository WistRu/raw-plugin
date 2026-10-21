// What a Bash command may write, read off its text: the second layer of the
// zone guard, for what Edit and Write do not see. Pure, tested. The command
// is split into words with quotes honoured (a quoted path is a path), so a
// target in quotes is seen; what stays conservative is the verb list: a
// program not on it (python, make, an own script) may write anywhere.

// Verbs whose arguments are written to: every path-like word of the segment
// is a target.
const WRITERS = new Set([
  'tee', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'truncate', 'dd', 'install', 'rsync', 'patch', 'unzip', 'tar',
])
// sed writes only with -i; perl and ruby with -i too.
const INPLACE = new Set(['sed', 'perl', 'ruby'])
// git verbs that rewrite the tree with no path to check: refused outright.
const GIT_TREE = new Set(['stash', 'reset', 'clean', 'rebase', 'merge', 'pull', 'cherry-pick', 'revert', 'checkout', 'restore', 'switch'])
// git verbs that take paths: each path is a target; none given means the
// whole tree.
const GIT_PATHS = new Set(['add', 'commit', 'mv', 'rm', 'apply'])
// git options before the verb that take a value; -C and --work-tree move
// the tree, so a command with them is read as the whole tree.
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])
const GIT_OPTS_MOVING = new Set(['-C', '--work-tree', '--git-dir'])
const LEADERS = new Set(['sudo', 'time', 'nice', 'ionice', 'nohup', 'exec', 'builtin', 'command', 'env', 'xargs'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash'])

export type WriteTargets = {
  // The writing verbs found, for the refusal's text.
  verbs: string[]
  // The path-like words beside them, as written (relative to the shell's cwd).
  paths: string[]
  // A verb that rewrites the tree with no path to check.
  isWholeTree: boolean
}

type Word = { text: string; isQuoted: boolean }

// The words of a command line with quotes honoured, split into segments at
// `|`, `||`, `&&`, `;`, `&` and newlines outside quotes. A redirection is
// its own word (`>`, `>>`, `2>`, `&>`) followed by the target word.
export function tokenize(command: string): Word[][] {
  const segments: Word[][] = [[]]
  let cur = ''
  let quoted = false
  let quote: string | undefined
  const push = () => {
    if (cur.length > 0 || quoted) (segments[segments.length - 1] ?? []).push({ text: cur, isQuoted: quoted })
    cur = ''
    quoted = false
  }
  const i0 = { i: 0 }
  for (i0.i = 0; i0.i < command.length; i0.i++) {
    const c = command[i0.i] ?? ''
    const next = command[i0.i + 1] ?? ''
    if (quote) {
      if (c === '\\' && quote === '"' && next) {
        cur += next
        i0.i++
      } else if (c === quote) quote = undefined
      else cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      quoted = true
      continue
    }
    if (c === '\\' && next) {
      cur += next
      i0.i++
      continue
    }
    if (/\s/.test(c)) {
      push()
      continue
    }
    if (c === '|' || c === '&' || c === ';' || c === '\n') {
      push()
      segments.push([])
      if ((c === '|' || c === '&') && next === c) i0.i++
      continue
    }
    if (c === '>' || (c === '<' && next === '>')) {
      // a redirection word: 2>, &>, >>, >|
      const fd = /^\d$/.test(cur) || cur === '&' ? cur : ''
      if (fd) cur = ''
      push()
      let op = c
      if (next === '>' || next === '|') {
        op += next
        i0.i++
      }
      ;(segments[segments.length - 1] ?? []).push({ text: `${fd}${op}`, isQuoted: false })
      continue
    }
    cur += c
  }
  push()
  return segments.filter(s => s.length > 0)
}

const isRedirect = (w: Word) => !w.isQuoted && /^(\d|&)?>{1,2}\|?$/.test(w.text)

const isPathLike = (w: Word): boolean => {
  const word = w.text
  if (word === '' || word === '-' || word === '--') return false
  if (!w.isQuoted && word.startsWith('-')) return false
  if (/^\w+:\/\//.test(word)) return false
  // a sed or y command, quoted or bare: s/x/y/, 's|a|b|', y/a/b/
  if (/^[sy][^A-Za-z0-9\s]/.test(word) && (word.match(/[/|@#]/g) ?? []).length >= 2) return false
  if (word === '.' || word === '..' || word === '~') return true
  if (/^(\/|\.\/|\.\.\/|~\/)/.test(word)) return true
  if (word.includes('/')) return true
  if (w.isQuoted) return /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(word)
  return /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(word) && !/^\d+(\.\d+)*$/.test(word)
}

// Leading `VAR=value` words and leaders dropped; the program's own name
// without its directory.
function program(words: Word[]): { name: string; rest: Word[] } {
  let list = [...words]
  while (list.length > 0 && !(list[0]?.isQuoted) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0]?.text ?? '')) list.shift()
  while (list.length > 0 && LEADERS.has(list[0]?.text ?? '')) {
    list.shift()
    // `sudo -u user cmd`, `nice -n 10 cmd`, `env X=1 cmd`
    while (list.length > 0 && (list[0]?.text.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0]?.text ?? ''))) {
      const opt = list.shift()?.text ?? ''
      if ((opt === '-u' || opt === '-n') && list.length > 0) list.shift()
    }
  }
  const head = list[0]?.text ?? ''
  return { name: head.slice(head.lastIndexOf('/') + 1), rest: list.slice(1) }
}

function readSegment(words: Word[], out: WriteTargets): void {
  // redirections first: each `>` word's target
  const plain: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? { text: '', isQuoted: false }
    if (isRedirect(w)) {
      const target = words[i + 1]
      i++
      if (!target || /^&\d*$/.test(target.text)) continue
      out.verbs.push('>')
      out.paths.push(target.text)
      continue
    }
    plain.push(w)
  }
  const { name, rest } = program(plain)
  if (SHELLS.has(name)) {
    // `bash -c "<inner>"`: what the inner command writes
    const at = rest.findIndex(w => w.text === '-c')
    const inner = at >= 0 ? rest[at + 1] : undefined
    if (inner) for (const seg of tokenize(inner.text)) readSegment(seg, out)
    return
  }
  if (WRITERS.has(name) || (INPLACE.has(name) && rest.some(w => !w.isQuoted && /^-\w*i/.test(w.text)))) {
    out.verbs.push(name)
    out.paths.push(...rest.filter(isPathLike).map(w => w.text))
    return
  }
  if (name === 'git') {
    let i = 0
    let moved = false
    while (i < rest.length && (rest[i]?.text ?? '').startsWith('-')) {
      const opt = rest[i]?.text ?? ''
      const bare = opt.split('=')[0] ?? opt
      if (GIT_OPTS_MOVING.has(bare)) moved = true
      i += GIT_OPTS_WITH_VALUE.has(bare) && !opt.includes('=') ? 2 : 1
    }
    const verb = rest[i]?.text ?? ''
    const after = rest.slice(i + 1)
    if (GIT_TREE.has(verb) || (moved && (GIT_PATHS.has(verb) || GIT_TREE.has(verb)))) {
      out.verbs.push(`git ${verb}`)
      out.isWholeTree = true
    } else if (GIT_PATHS.has(verb)) {
      out.verbs.push(`git ${verb}`)
      const dd = after.findIndex(w => w.text === '--')
      const args = dd >= 0 ? after.slice(dd + 1) : after
      const paths = args.filter(isPathLike).map(w => w.text)
      if (paths.length === 0 || after.some(w => !w.isQuoted && (w.text === '-A' || w.text === '-a' || w.text === '--all' || w.text === '.'))) out.isWholeTree = true
      out.paths.push(...paths.filter(p => p !== '.'))
    }
  }
}

// Undefined when the command writes nothing this reading can see.
export function writeTargets(command: string): WriteTargets | undefined {
  const out: WriteTargets = { verbs: [], paths: [], isWholeTree: false }
  for (const seg of tokenize(command)) readSegment(seg, out)
  return out.verbs.length > 0 ? out : undefined
}
