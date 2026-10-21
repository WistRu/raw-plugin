import type { On, EngineInterface, PluginOptions } from 'claude-code'
import { isLight, signature, stripOldWrapper } from './commands'

// ---- Settings (edit here) -------------------------------------------------

// Share of total RAM that must stay available after a heavy command starts.
const RESERVE_SHARE = 0.25
// ...but never less than this many bytes (small machines).
const RESERVE_MIN = 2 * 1024 ** 3
// A heavy command waits while busy cores exceed cores * this.
const CPU_FACTOR = 1.0
// How often the status line is refreshed and the watchdog looks, in milliseconds.
const TICK_MS = 10_000
// After a heavy command starts, the next one waits until the first one's
// memory stops growing, or this long, whichever comes first.
const RAMP_MS = 20_000
const RAMP_STEP_MS = 2_000
// A known command is expected to take its last peak times this.
const PEAK_MARGIN = 1.2
// How many command signatures the memory of peaks keeps.
const PEAKS_KEPT = 200
// Memory slice (Linux with systemd): made at session start from this machine's
// RAM. Above HIGH the kernel slows jobs down and reclaims memory instead of
// killing; at MAX a job (never a desktop app) is killed; SWAP caps the spill.
const SLICE = 'claude-heavy.slice'
const SLICE_HIGH_SHARE = 0.6 // of total RAM
const SLICE_MAX_SHARE = 0.8 // of total RAM
const SLICE_SWAP_SHARE = 0.5 // of total swap
// Without a slice (macOS, Windows, Linux without systemd) the watchdog kills
// the newest own job when available RAM falls under this many bytes.
const WATCHDOG_MIN = 1 * 1024 ** 3

// ---- Probe ----------------------------------------------------------------

type Probe = {
  os: string
  cores: number
  mem_total: number
  mem_avail: number
  swap_total: number
  swap_free: number
  load1: number
  cpu: number
  heavy_jobs: number
  systemd: number
  swap_dynamic: number
  tmp: string
  top: string
}

type Peak = { peak: number; runs: number; at: number }
type Job = { id: string; sig: string; startedAt: number; files: { sh: string; peak: string; pid: string } }

const GB = 1024 ** 3
const gb = (n: number) => (n / GB).toFixed(1)
const PEAKS_KEY = 'resource-guard:peaks'
const SWAP_HINT_KEY = 'resource-guard:swap-hint-shown'

let profile: Probe | undefined
let last: Probe | undefined
let sliceReady = false
let peaks: Record<string, Peak> = {}
const running = new Map<string, Job>()
// Heavy commands are admitted one at a time; the gate opens after the ramp.
let gate: Promise<void> = Promise.resolve()

const PROBE = 'hooks/resource-guard/probe.sh'
const SETUP = 'hooks/resource-guard/setup-swap.sh'

async function probe($: EngineInterface): Promise<Probe> {
  const { exitCode, stdout } = await $.process.run(['sh', `${$.plugin.root}/${PROBE}`, SLICE], { timeoutMs: 5000 })
  if (exitCode !== 0) throw new Error(`probe exited ${exitCode}`)
  last = JSON.parse(stdout.trim()) as Probe
  profile ??= last
  return last
}

const reserve = (p: Probe) => Math.max(RESERVE_MIN, p.mem_total * RESERVE_SHARE)

// Why a command cannot start now, or undefined when it can. `expected` is the
// memory the command is known to take, 0 when unknown.
function shortage(p: Probe, expected: number): string | undefined {
  const need = reserve(p) + expected
  if (p.mem_avail < need) {
    const known = expected > 0 ? ` and this command took ${gb(expected / PEAK_MARGIN)} GB last time` : ''
    return `RAM: ${gb(p.mem_avail)} GB available, ${gb(reserve(p))} GB must stay free${known}`
  }
  const maxCpu = p.cores * CPU_FACTOR
  if (p.cpu > maxCpu) return `CPU: ${p.cpu.toFixed(1)} of ${p.cores} cores busy`
  return undefined
}

function snapshot(p: Probe): string {
  const swap = p.swap_total > 0 ? `, swap free ${gb(p.swap_free)}/${gb(p.swap_total)} GB` : ', no swap'
  const jobs = running.size > 0 ? `, own heavy jobs running: ${running.size}` : ''
  const top = p.top ? `. Biggest: ${p.top}` : ''
  return `RAM available ${gb(p.mem_avail)}/${gb(p.mem_total)} GB${swap}, CPU busy ${p.cpu.toFixed(1)}/${p.cores} cores${jobs}${top}`
}

function statusLine(p: Probe): string {
  const swap = p.swap_total > 0 ? ` · swap ${gb(p.swap_free)}G` : ''
  const jobs = running.size > 0 ? ` · jobs ${running.size}` : ''
  return `RAM ${gb(p.mem_avail)}/${gb(p.mem_total)}G${swap} · cpu ${p.cpu.toFixed(1)}/${p.cores}${jobs}`
}

// ---- Slice and wrappers ---------------------------------------------------

async function makeSlice($: EngineInterface, p: Probe): Promise<void> {
  const high = Math.floor(p.mem_total * SLICE_HIGH_SHARE)
  const max = Math.floor(p.mem_total * SLICE_MAX_SHARE)
  const swap = Math.floor(p.swap_total * SLICE_SWAP_SHARE)
  const { exitCode, stderr } = await $.process.run(
    ['systemctl', '--user', 'set-property', '--runtime', SLICE, `MemoryHigh=${high}`, `MemoryMax=${max}`, `MemorySwapMax=${swap}`],
    { timeoutMs: 10_000 },
  )
  if (exitCode !== 0) throw new Error(`systemctl set-property exited ${exitCode}: ${stderr.trim()}`)
  sliceReady = true
  $.ui.log(`${$.plugin.name}: ${SLICE} high ${gb(high)} GB, max ${gb(max)} GB, swap ${gb(swap)} GB`, { to: 'debug' })
}

// The command is written to a script file, so no quoting of it is needed.
// In the slice: run as a scope of its own, OOM killer pointed at it, and the
// scope's memory peak saved for next time. systemd-run reads `$$` as `$`, so
// every `$` in its command line is doubled. Elsewhere: the PID saved for the
// watchdog, then the script replaces the shell.
function wrap(job: Job): string {
  if (sliceReady) {
    const inner = `bash "${job.files.sh}"; rc=$$?; cat "/sys/fs/cgroup$$(cut -d: -f3 /proc/self/cgroup)/memory.peak" > "${job.files.peak}" 2>/dev/null; exit $$rc`
    return `systemd-run --user --scope --quiet --slice=${SLICE} -- choom -n 900 -- bash -c '${inner}'`
  }
  return `bash -c 'echo $$ > "${job.files.pid}"; exec bash "${job.files.sh}"'`
}

// ---- Memory of peaks ------------------------------------------------------

async function loadPeaks($: EngineInterface): Promise<void> {
  const stored = await $.store.get(PEAKS_KEY)
  peaks = stored && typeof stored === 'object' ? (stored as Record<string, Peak>) : {}
}

const expected = (sig: string) => (peaks[sig]?.peak ?? 0) * PEAK_MARGIN

async function learnPeak($: EngineInterface, job: Job, now: number): Promise<void> {
  if (!sliceReady) return
  let peak: number
  try {
    peak = Number((await $.fs.read(job.files.peak)).trim())
  } catch {
    return
  }
  if (!Number.isFinite(peak) || peak <= 0) return
  const old = peaks[job.sig]
  // The newest peak wins, an older larger one fades slowly.
  peaks[job.sig] = { peak: Math.max(peak, (old?.peak ?? 0) * 0.8), runs: (old?.runs ?? 0) + 1, at: now }
  const keys = Object.keys(peaks)
  if (keys.length > PEAKS_KEPT) {
    keys.sort((a, b) => (peaks[a]?.at ?? 0) - (peaks[b]?.at ?? 0))
    for (const k of keys.slice(0, keys.length - PEAKS_KEPT)) delete peaks[k]
  }
  await $.store.set(PEAKS_KEY, peaks)
  $.ui.log(`${$.plugin.name}: "${job.sig.slice(0, 60)}" peaked at ${gb(peak)} GB`, { to: 'debug' })
}

// Holds the gate until the newest job's memory stops growing, or RAMP_MS.
async function ramp($: EngineInterface, job: Job): Promise<void> {
  let before = last?.mem_avail ?? 0
  for (let waited = 0; waited < RAMP_MS && running.has(job.id); waited += RAMP_STEP_MS) {
    await $.clock.sleep(RAMP_STEP_MS)
    let p: Probe
    try {
      p = await probe($)
    } catch {
      return
    }
    $.ui.status(statusLine(p))
    if (before - p.mem_avail < p.mem_total * 0.01) return
    before = p.mem_avail
  }
}

// ---- Watchdog (no slice) --------------------------------------------------

async function watchdog($: EngineInterface, p: Probe): Promise<void> {
  if (sliceReady || running.size === 0 || p.mem_avail >= WATCHDOG_MIN) return
  const newest = [...running.values()].sort((a, b) => b.startedAt - a.startedAt)[0]
  if (!newest) return
  let pid: string
  try {
    pid = (await $.fs.read(newest.files.pid)).trim()
  } catch {
    return
  }
  if (!/^\d+$/.test(pid)) return
  await $.process.run(['sh', '-c', `pkill -TERM -P ${pid}; kill -TERM ${pid}`], { timeoutMs: 5000 })
  $.ui.log(`${$.plugin.name}: only ${gb(p.mem_avail)} GB RAM left, stopped the newest heavy job (pid ${pid}) so the desktop survives`)
}

// ---- Hints ----------------------------------------------------------------

function swapHint($: EngineInterface, p: Probe): string | undefined {
  if (p.os !== 'Linux' || p.swap_dynamic === 1) return undefined
  return `${$.plugin.name}: swap on this machine is fixed-size. For Mac-like swap (compressed in RAM, disk files made on demand) run once, with the administrator password:\n  sudo ${$.plugin.root}/${SETUP}`
}

const KILLED = /exit code 137|killed|SIGKILL/i

// ---- Hooks ----------------------------------------------------------------

export function registerResourceGuard(on: On, _options: PluginOptions): void {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    sliceReady = false
    running.clear()
    try {
      const p = await probe($)
      $.ui.status(statusLine(p))
      await loadPeaks($)
      if (p.systemd === 1) await makeSlice($, p)
      const hint = swapHint($, p)
      if (hint && !(await $.store.get(SWAP_HINT_KEY))) {
        $.ui.log(hint)
        await $.store.set(SWAP_HINT_KEY, true)
      }
    } catch (err) {
      $.ui.log(`${$.plugin.name}: setup failed: ${String(err)}`, { to: 'debug' })
    }
    $.clock.every(TICK_MS, async () => {
      try {
        const p = await probe($)
        $.ui.status(statusLine(p))
        await watchdog($, p)
      } catch {
        // keep the previous line
      }
    })
    await $.tool.register({
      name: 'resources',
      description:
        'Current machine load: available RAM, swap, busy CPU, own heavy jobs, the biggest processes, and whether a heavy command may start now. Call before choosing how many jobs to run in parallel.',
      inputSchema: { type: 'object', properties: {} },
    })
    $.command.register({
      name: 'resources',
      description: 'Show machine resources and current load; "setup" shows how to make swap Mac-like',
      argumentHint: '[setup]',
    })
    return started
  })

  // The model reads the machine once, in the system prompt: cheap and cached.
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    const p = profile
    if (!p) return { sections }
    const text = [
      `# Machine resources (${$.plugin.name})`,
      `This machine: ${p.os}, ${p.cores} cores, ${gb(p.mem_total)} GB RAM, ${p.swap_total > 0 ? gb(p.swap_total) + ' GB swap' : 'no swap'}.`,
      `Every Bash command except plain file, text and git work counts as heavy: it is held with the current figures while less than ${gb(reserve(p))} GB RAM is available (plus what the command took last time) or all ${p.cores} cores are busy. Then wait, or run fewer in parallel, and retry. Heavy commands start one at a time.`,
      `Before starting several jobs at once, call the tool mcp__${$.plugin.name}__resources and size the batch by it.`,
      sliceReady
        ? `A heavy command runs inside the memory slice ${SLICE} by itself (slowed down above ${gb(p.mem_total * SLICE_HIGH_SHARE)} GB, killed at ${gb(p.mem_total * SLICE_MAX_SHARE)} GB: exit 137 means that, rerun with fewer jobs). Write the plain command, never a wrapper such as \`heavy\`. Inside it \`cd\` does not carry over to the next command.`
        : `There is no memory cap here: when RAM runs out, the newest heavy command is stopped so the desktop survives. Write the plain command; there is no wrapper to add.`,
    ].join('\n')
    return { sections: [...sections, { id: `${$.plugin.name}:machine`, text, scope: 'session' }] }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = stripOldWrapper(e.command)
    if (isLight(command)) return next({ ...e, command })

    await gate
    let open!: () => void
    gate = new Promise<void>(r => (open = r))
    let job: Job | undefined
    try {
      let p: Probe
      try {
        p = await probe($)
      } catch (err) {
        $.ui.log(`${$.plugin.name}: probe failed, command not checked: ${String(err)}`, { to: 'debug' })
        open()
        return next({ ...e, command })
      }
      const sig = signature(command)
      const why = shortage(p, expected(sig))
      if (why) {
        open()
        $.ui.log(`${$.plugin.name}: held a heavy command — ${why}`)
        return {
          deny: `${$.plugin.name}: no headroom for a heavy command. ${why}. Now: ${snapshot(p)}. Wait or run fewer jobs in parallel, then retry.`,
        }
      }
      if (!p.tmp) {
        open()
        return next({ ...e, command })
      }
      const now = await $.clock.now()
      const id = `${now}-${(e.tool_use_id ?? '').replace(/[^A-Za-z0-9]/g, '').slice(-12)}`
      job = {
        id, sig, startedAt: now,
        files: { sh: `${p.tmp}/${id}.sh`, peak: `${p.tmp}/${id}.peak`, pid: `${p.tmp}/${id}.pid` },
      }
      await $.fs.write(job.files.sh, command + '\n')
      running.set(id, job)
      $.ui.status(statusLine(p))
      $.ui.log(`${$.plugin.name}: heavy command started${sliceReady ? ` in ${SLICE}` : ''} — ${snapshot(p)}`, { to: 'debug' })
      void ramp($, job).finally(open)

      const ran = await next({ ...e, command: wrap(job) })
      running.delete(id)
      await learnPeak($, job, await $.clock.now())
      if (ran.deny === undefined && ran.isError === true && KILLED.test(ran.text ?? '')) {
        return {
          ...ran,
          text: `${ran.text ?? ''}\n\n${$.plugin.name}: the command was killed by the memory cap (exit 137). Rerun it with fewer jobs in parallel or less memory.`,
        }
      }
      return ran
    } catch (err) {
      if (job) running.delete(job.id)
      open()
      throw err
    }
  }).catch(($, e, next) => (next.called ? next(e) : next({ ...e, command: stripOldWrapper(e.command) })))

  on('tool.call', { tool: 'mcp__raw-plugin__resources' }, async $ => {
    const p = await probe($)
    const why = shortage(p, 0)
    const text = `${snapshot(p)}. ${why ? `No headroom for a heavy command: ${why}.` : `A heavy command may start now.`}`
    return { result: text, text, isReadOnly: true }
  })

  on('command.run', { command: 'resources' }, async ($, e) => {
    const p = await probe($)
    return { text: (e.args ?? '').trim() === 'setup' ? setupText($, p) : resourcesText(p) }
  })

  // The same commands under the plugin's own prefix, as commands/*.md list
  // them; answered here directly, so the model is never involved.
  on('command.run', { command: 'raw-plugin:resources' }, async $ => ({ text: resourcesText(await probe($)) }))
  on('command.run', { command: 'raw-plugin:setup' }, async $ => {
    const p = await probe($)
    return { text: setupText($, p) }
  })
}

function setupText($: EngineInterface, p: Probe): string {
  return (
    swapHint($, p) ??
    (p.os === 'Linux' ? 'Swap is already dynamic here: zram plus swapspace are active.' : `${p.os} manages swap by itself: nothing to set up.`)
  )
}

function resourcesText(p: Probe): string {
  return `${snapshot(p)}\n${shortage(p, 0) ?? 'A heavy command may start now.'}`
}
