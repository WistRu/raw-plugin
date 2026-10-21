// Pure helpers over a Bash command's text: what is light, how a command is
// recognised again, and the old `heavy` wrapper word.

// Commands that never need a check: every segment of a light command starts
// with one of these. Everything else is treated as heavy (unknown = heavy).
export const LIGHT = new Set([
  'git', 'gh', 'ls', 'cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'find', 'fd',
  'echo', 'printf', 'pwd', 'cd', 'which', 'command', 'type', 'test', '[', 'true', 'false',
  'sed', 'awk', 'sort', 'uniq', 'wc', 'cut', 'tr', 'tee', 'diff', 'comm', 'paste', 'column',
  'nl', 'tac', 'rev', 'xargs', 'jq', 'yq', 'date', 'sleep', 'env', 'export', 'set', 'unset',
  'stat', 'file', 'du', 'df', 'free', 'uptime', 'ps', 'pgrep', 'pkill', 'kill', 'top', 'htop',
  'mkdir', 'rmdir', 'rm', 'mv', 'cp', 'touch', 'ln', 'chmod', 'chown', 'readlink', 'realpath',
  'basename', 'dirname', 'md5sum', 'sha256sum', 'base64', 'xxd', 'hexdump', 'strings',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'systemctl', 'journalctl', 'zramctl', 'swapon',
  'sysctl', 'nproc', 'id', 'whoami', 'hostname', 'uname', 'open', 'xdg-open', 'code',
  'claude', 'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'xz', 'zstd', 'man', 'apt-cache',
  'dpkg', 'pip', 'uv', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'rustc', 'python', 'python3',
  'node', 'deno', 'bun', 'ruby', 'perl', 'go', 'make', 'docker', 'ffmpeg', 'bash', 'sh', 'zsh',
])

// Package managers, compilers and interpreters are light only for their quick
// verbs; with any other verb (build, run, test, install, a script) they are heavy.
const LIGHT_VERBS: Record<string, Set<string>> = {
  cargo: new Set(['--version', '-V', 'metadata', 'tree', 'search', 'fmt', 'clippy-version', 'help', 'add', 'remove']),
  npm: new Set(['--version', '-v', 'ls', 'list', 'view', 'info', 'config', 'help', 'pkg', 'outdated', 'why']),
  pnpm: new Set(['--version', '-v', 'ls', 'list', 'view', 'info', 'config', 'help', 'why']),
  yarn: new Set(['--version', '-v', 'list', 'info', 'config', 'help', 'why']),
  npx: new Set(['--version', '-v']),
  pip: new Set(['--version', 'list', 'show', 'freeze', 'config', 'help', 'check']),
  uv: new Set(['--version', 'pip', 'tree', 'lock', 'help', 'version']),
  python: new Set(['--version', '-V']),
  python3: new Set(['--version', '-V']),
  node: new Set(['--version', '-v']),
  deno: new Set(['--version']),
  bun: new Set(['--version', '-v']),
  ruby: new Set(['--version', '-v']),
  perl: new Set(['--version', '-v']),
  go: new Set(['version', 'env', 'list', 'help']),
  rustc: new Set(['--version', '-V']),
  make: new Set(['--version', '-v', '-n', '--dry-run', '-q', '--question']),
  docker: new Set(['ps', 'images', 'version', 'info', 'inspect', 'logs', 'stats', 'help']),
  ffmpeg: new Set(['-version', '-formats', '-codecs', '-h']),
  bash: new Set(['-n', '--version', '-c']),
  sh: new Set(['-n', '--version']),
  zsh: new Set(['-n', '--version']),
  claude: new Set(['--version', '-v', 'plugin', 'mcp', 'config', 'auth', 'help', '--help']),
}

// Words that may lead a segment without being the command.
const LEADERS = new Set(['sudo', 'time', 'nice', 'ionice', 'nohup', 'exec', 'builtin', 'command', 'env'])

// A command that still says `heavy ...` from the old wrapper: the word is dropped.
export const stripOldWrapper = (command: string) => command.replace(/^\s*heavy\s+/, '')

// The segments of a command line: the parts between `|`, `||`, `&&`, `;`,
// `&` and newlines, each with leading `(`, `{`, `!` and VAR=value assignments
// stripped. Quotes are not parsed: a quoted operator splits too, which only
// makes a light command look heavy, never the reverse.
export function segments(command: string): string[] {
  return command
    .split(/\|\||&&|[|;&\n]/)
    .map(s => s.trim().replace(/^[({!\s]+/, '').replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').trim())
    .filter(s => s.length > 0)
}

function firstWords(segment: string): string[] {
  const words = segment.split(/\s+/)
  while (words.length > 0 && LEADERS.has(words[0] ?? '')) words.shift()
  const head = words[0] ?? ''
  words[0] = head.slice(head.lastIndexOf('/') + 1)
  return words
}

// `bash -c '...'` is light only when what it runs is light.
function innerCommand(words: string[]): string | undefined {
  if (!['bash', 'sh', 'zsh'].includes(words[0] ?? '') || words[1] !== '-c') return undefined
  return words.slice(2).join(' ').replace(/^(['"])(.*)\1$/s, '$2')
}

export function isLight(command: string): boolean {
  const parts = segments(command)
  if (parts.length === 0) return true
  return parts.every(segment => {
    const words = firstWords(segment)
    const name = words[0] ?? ''
    if (!LIGHT.has(name)) return false
    const inner = innerCommand(words)
    if (inner !== undefined) return isLight(inner)
    const verbs = LIGHT_VERBS[name]
    if (!verbs) return true
    const verb = words[1]
    return verb === undefined || verbs.has(verb)
  })
}

// How a command is recognised again across runs: numbers, hashes, dates and
// quoted strings replaced, paths kept, cut to 120 characters.
export function signature(command: string): string {
  return command
    .replace(/(["'])(?:\\.|(?!\1).)*\1/g, '"')
    .replace(/\b[0-9a-f]{7,}\b/gi, '#')
    .replace(/(?<![A-Za-z_])\d+(\.\d+)?(?![A-Za-z_])/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}
