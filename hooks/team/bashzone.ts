// What a Bash command may write, read off its text: the second layer of the
// zone guard, for what Edit and Write do not see. Pure, tested. Quotes are
// not parsed beyond being removed, so the reading is conservative: a path
// that merely appears beside a writing verb counts as a target, and a verb
// that rewrites the whole tree counts as every path.

import { segments } from '../resource-guard/commands'

// Verbs whose arguments are written to: every path-like word of the segment
// is a target.
const WRITERS = new Set([
  'tee', 'cp', 'mv', 'rm', 'rmdir', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'truncate', 'dd', 'install', 'rsync', 'patch', 'unzip', 'tar',
])
// sed writes only with -i; perl and ruby with -i or -p... are treated the same.
const INPLACE = new Set(['sed', 'perl', 'ruby'])
// git verbs that rewrite the tree with no path to check: refused outright.
const GIT_TREE = new Set(['stash', 'reset', 'clean', 'rebase', 'merge', 'pull', 'cherry-pick', 'revert', 'checkout', 'restore', 'switch'])
// git verbs that take paths: each path is a target; none given means the
// whole tree.
const GIT_PATHS = new Set(['add', 'commit', 'mv', 'rm', 'apply'])
const LEADERS = new Set(['sudo', 'time', 'nice', 'ionice', 'nohup', 'exec', 'builtin', 'command', 'env'])

export type WriteTargets = {
  // The writing verbs found, for the refusal's text.
  verbs: string[]
  // The path-like words beside them, as written (relative to the shell's cwd).
  paths: string[]
  // A verb that rewrites the tree with no path to check.
  isWholeTree: boolean
}

const stripQuotes = (text: string) => text.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ' ')

const isPathLike = (word: string): boolean => {
  if (word.startsWith('-')) return false
  if (/^\w+:\/\//.test(word)) return false
  // a sed or y command written bare: s/x/y/, y|a|b|
  if (/^[sy][^A-Za-z0-9\s]/.test(word) && (word.match(/[/|@#]/g) ?? []).length >= 2) return false
  if (/^(\/|\.\/|\.\.\/|~\/|~$)/.test(word)) return true
  if (word.includes('/')) return true
  return /^[\w.-]+\.[A-Za-z0-9]{1,8}$/.test(word) && !/^\d+(\.\d+)*$/.test(word)
}

function words(segment: string): string[] {
  const list = segment.split(/\s+/).filter(w => w.length > 0)
  while (list.length > 0 && LEADERS.has(list[0] ?? '')) list.shift()
  const head = list[0] ?? ''
  list[0] = head.slice(head.lastIndexOf('/') + 1)
  return list
}

// Undefined when the command writes nothing this reading can see.
export function writeTargets(command: string): WriteTargets | undefined {
  const out: WriteTargets = { verbs: [], paths: [], isWholeTree: false }
  for (const raw of segments(stripQuotes(command))) {
    // a redirection writes to the word after it
    const redirected = [...raw.matchAll(/(?:^|\s)\d?>{1,2}\|?\s*(\S+)/g)].map(m => m[1] ?? '').filter(w => w !== '' && !/^&\d/.test(w))
    if (redirected.length > 0) {
      out.verbs.push('>')
      out.paths.push(...redirected.filter(isPathLike))
      if (redirected.some(w => !isPathLike(w))) out.paths.push(...redirected)
    }
    const list = words(raw.replace(/\d?>{1,2}\|?\s*\S+/g, ' '))
    const name = list[0] ?? ''
    const rest = list.slice(1)
    if (WRITERS.has(name) || (INPLACE.has(name) && rest.some(w => /^-\w*i/.test(w)))) {
      out.verbs.push(name)
      out.paths.push(...rest.filter(isPathLike))
      continue
    }
    if (name === 'git') {
      const verb = rest.find(w => !w.startsWith('-')) ?? ''
      if (GIT_TREE.has(verb)) {
        out.verbs.push(`git ${verb}`)
        out.isWholeTree = true
      } else if (GIT_PATHS.has(verb)) {
        out.verbs.push(`git ${verb}`)
        const after = rest.slice(rest.indexOf(verb) + 1)
        const paths = (after.includes('--') ? after.slice(after.indexOf('--') + 1) : after).filter(isPathLike)
        if (paths.length === 0 || after.some(w => w === '-A' || w === '-a' || w === '--all')) out.isWholeTree = true
        out.paths.push(...paths)
      }
    }
  }
  return out.verbs.length > 0 ? out : undefined
}
