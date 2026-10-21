import { expect, test } from 'claude-code/testing'

const GB = 1024 ** 3
const TOOL = 'mcp__rp__resources'

type Fake = { mem_avail?: number; cpu?: number; systemd?: number; swap_dynamic?: number; tmp?: string }

// A probe answer, as probe.sh prints it.
const machine = (f: Fake = {}) =>
  JSON.stringify({
    os: 'Linux', cores: 6, mem_total: 32 * GB, mem_avail: f.mem_avail ?? 20 * GB,
    swap_total: 16 * GB, swap_free: 8 * GB, load1: 1, cpu: f.cpu ?? 1, heavy_jobs: 0,
    systemd: f.systemd ?? 0, swap_dynamic: f.swap_dynamic ?? 1, tmp: f.tmp ?? '/tmp/raw-plugin',
    top: 'chrome 3.0G, claude 1.0G, code 0.5G',
  })

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

type BashAnswer = { result: unknown; text: string; isError?: true }
type World = {
  machine: () => string
  probeExit: number
  bashAnswer: (command: string) => BashAnswer
  files: Map<string, string>
  store: Map<string, unknown>
  logged: string[]
  runs: string[][]
  bash: string[]
}

// What the engine answers beneath the plugin: nothing sits below in a test.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], fake: Partial<World> = {}): World {
  const w: World = {
    machine: fake.machine ?? (() => machine()),
    probeExit: fake.probeExit ?? 0,
    bashAnswer: fake.bashAnswer ?? (() => ({ result: 'ran', text: 'ran' })),
    files: fake.files ?? new Map(),
    store: fake.store ?? new Map(),
    logged: [], runs: [], bash: [],
  }
  on('process.run', (_, e) => {
    w.runs.push([...e.argv])
    if (e.argv[0] === 'sh' && String(e.argv[1]).endsWith('probe.sh'))
      return w.probeExit === 0
        ? ok(w.machine())
        : { value: { exitCode: w.probeExit, stdout: '', stderr: 'boom', isStdoutTruncated: false, isStderrTruncated: false } }
    return ok('')
  })
  on('fs.write', (_, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    const text = w.files.get(e.path)
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('store.get', (_, e) => ({ value: w.store.get(e.key) }))
  on('store.set', (_, e) => {
    w.store.set(e.key, e.value)
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_, e) => {
    w.logged.push(e.text)
    return { value: undefined }
  })
  on('tool.register', () => ({ value: { tool: TOOL } }))
  on('command.register', () => ({ value: { command: 'resources' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', (_, e) => {
    if (e.tool !== 'Bash') return { result: 'ran', text: 'ran' }
    w.bash.push(e.command)
    return w.bashAnswer(e.command)
  })
  return w
}

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

test('a light command is never probed and runs as typed', async ($, on) => {
  const w = engine(on)
  await start($)
  const probes = () => w.runs.filter(r => String(r[1]).endsWith('probe.sh')).length
  const before = probes()
  const ran = await $.tool.call({ tool: 'Bash', command: 'git status && ls' })
  expect(ran.text).toBe('ran')
  expect(probes()).toBe(before)
  expect(w.bash.at(-1)).toBe('git status && ls')
})

test('a heavy command is held when RAM or CPU is short, and passes when not', async ($, on) => {
  let fake: Fake = { mem_avail: 3 * GB }
  const w = engine(on, { machine: () => machine(fake) })
  await start($)

  const held = await $.tool.call({ tool: 'Bash', command: './sim --days 30' })
  expect(held.deny).toMatch(/no headroom/)
  expect(held.deny).toMatch(/8\.0 GB must stay free/)
  expect(held.deny).toMatch(/Biggest: chrome/)

  fake = { cpu: 6.5 }
  const busy = await $.tool.call({ tool: 'Bash', command: './sim --days 30' })
  expect(busy.deny).toMatch(/CPU: 6\.5 of 6 cores busy/)

  fake = {}
  const ran = await $.tool.call({ tool: 'Bash', command: 'heavy ./sim --days 30' })
  expect(ran.deny).toBeUndefined()
  expect(ran.text).toBe('ran')
  // Without a slice: the command is a script file, the pid kept for the watchdog.
  const sh = [...w.files.keys()].find(k => k.endsWith('.sh'))
  expect(sh).toBeDefined()
  expect(w.files.get(sh!)).toBe('./sim --days 30\n')
  expect(w.bash.at(-1)).toMatch(/^bash -c 'echo \$\$ > "\/tmp\/raw-plugin\/.*\.pid"; exec bash "\/tmp\/raw-plugin\/.*\.sh"'$/)
})

test('with systemd the slice is made from RAM shares and the command runs inside it', async ($, on) => {
  const w = engine(on, { machine: () => machine({ systemd: 1 }) })
  await start($)
  const set = w.runs.find(r => r[0] === 'systemctl')
  expect(set).toEqual([
    'systemctl', '--user', 'set-property', '--runtime', 'claude-heavy.slice',
    `MemoryHigh=${Math.floor(32 * GB * 0.6)}`, `MemoryMax=${Math.floor(32 * GB * 0.8)}`, `MemorySwapMax=${Math.floor(16 * GB * 0.5)}`,
  ])

  await $.tool.call({ tool: 'Bash', command: "cargo run --release -- --name 'a b' --pid $$" })
  const cmd = w.bash.at(-1) ?? ''
  expect(cmd.startsWith('systemd-run --user --scope --quiet --slice=claude-heavy.slice -- choom -n 900 -- bash -c ')).toBe(true)
  expect(cmd).toMatch(/memory\.peak/)
  expect(cmd).not.toMatch(/[^$]\$[^$]/) // every $ doubled for systemd-run
  const sh = [...w.files.keys()].find(k => k.endsWith('.sh'))
  expect(w.files.get(sh!)).toBe("cargo run --release -- --name 'a b' --pid $$\n")
})

test('a peak is learned in the slice and holds the same command next time', async ($, on) => {
  let avail = 20 * GB
  const w = engine(on, {
    machine: () => machine({ systemd: 1, mem_avail: avail }),
    bashAnswer: command => {
      // The job "ran": its scope's peak file appears, once.
      const peak = [...w.files.keys()].find(k => k.endsWith('.peak'))
      const sh = command.match(/"(\/tmp\/raw-plugin\/[^"]+)\.sh"/)?.[1]
      if (sh && !peak) w.files.set(`${sh}.peak`, `${5 * GB}\n`)
      return { result: 'ran', text: 'ran' }
    },
  })
  await start($)

  const first = await $.tool.call({ tool: 'Bash', command: 'python3 train.py --epochs 10' })
  expect(first.deny).toBeUndefined()
  const peaks = w.store.get('resource-guard:peaks') as Record<string, { peak: number; runs: number }>
  expect(peaks['python3 train.py --epochs #']?.peak).toBe(5 * GB)
  expect(peaks['python3 train.py --epochs #']?.runs).toBe(1)

  // 12 GB available: enough for the reserve (8), not for reserve + 5 * 1.2.
  avail = 12 * GB
  const second = await $.tool.call({ tool: 'Bash', command: 'python3 train.py --epochs 20' })
  expect(second.deny).toMatch(/took 5\.0 GB last time/)
  const other = await $.tool.call({ tool: 'Bash', command: 'python3 other.py' })
  expect(other.deny).toBeUndefined()
})

test('a command killed by the memory cap gets a note for the model', async ($, on) => {
  engine(on, {
    machine: () => machine({ systemd: 1 }),
    bashAnswer: () => ({ isError: true, result: 'x', text: 'Exit code 137\nKilled' }),
  })
  await start($)
  const ran = await $.tool.call({ tool: 'Bash', command: './sim' })
  expect(ran.isError).toBe(true)
  expect(ran.text).toMatch(/killed by the memory cap \(exit 137\)/)
})

test('a failed probe lets a heavy command through, unwrapped', async ($, on) => {
  const w = engine(on, { probeExit: 1 })
  await start($)
  const ran = await $.tool.call({ tool: 'Bash', command: 'heavy ./sim' })
  expect(ran.text).toBe('ran')
  expect(w.bash.at(-1)).toBe('./sim')
})

test('the resources tool and command report the snapshot; setup hints once per machine', async ($, on) => {
  const w = engine(on, { machine: () => machine({ swap_dynamic: 0 }) })
  await start($)
  await start($)
  expect(w.logged.filter(t => t.includes('setup-swap.sh')).length).toBe(1)

  const tool = await $.tool.call({ tool: TOOL })
  expect(tool.text).toMatch(/RAM available 20\.0\/32\.0 GB/)
  expect(tool.text).toMatch(/may start now/)

  const cmd = await $.command.run({ command: 'resources', args: '' })
  expect(cmd.text).toMatch(/CPU busy 1\.0\/6 cores/)
  const setup = await $.command.run({ command: 'resources', args: 'setup' })
  expect(setup.text).toMatch(/sudo .*setup-swap\.sh/)

  // The prefixed commands (commands/*.md) are answered by the hooks too.
  const prefixed = await $.command.run({ command: 'rp:resources', args: '' })
  expect(prefixed.text).toMatch(/CPU busy 1\.0\/6 cores/)
  const prefixedSetup = await $.command.run({ command: 'rp:setup', args: '' })
  expect(prefixedSetup.text).toMatch(/sudo .*setup-swap\.sh/)
})
