import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Program, Snapshot } from '../../types'

const PANE = 'sysmon'
const INTERVAL_MS = 500
// the process list once a second, disk space every half minute, in samples
const PROCS_EVERY = Math.max(1, Math.round(1000 / INTERVAL_MS))
const DISK_EVERY = Math.max(1, Math.round(30_000 / INTERVAL_MS))
const snap = atom({ plugin: 'rp', key: 'snap' } as const, null)
// Whether the summary line under the prompt is drawn (resource-guard draws it).
export const isLineOn = atom({ plugin: 'rp', key: 'isLineOn' } as const, true)

// The newest sample, for other modules (resource-guard reads it instead of
// spawning its own probe on Linux); undefined before the first sample.
let latestSnapshot: Snapshot | undefined
let samples = 0
export const latest = (): Snapshot | undefined => latestSnapshot
// How many samples were taken this session: the first one has no rates yet.
export const sampleCount = (): number => samples
// One sample now, outside the timer (tests).
export const sampleNow = ($: EngineInterface): Promise<void> => sample($)

const TICKS = 100 // USER_HZ: /proc counts CPU time in 1/100 s
const PAGE = 4096
const SECTOR = 512
const GPU_GT = '/sys/class/drm/card1/device/tile0/gt0'

// ---- parsers (pure, tested) ----

export type CpuTimes = { busy: number; all: number }

export const parseCpu = (stat: string): { total: CpuTimes; cores: CpuTimes[] } => {
  let total: CpuTimes = { busy: 0, all: 0 }
  const cores: CpuTimes[] = []
  for (const line of stat.split('\n')) {
    const m = line.match(/^cpu(\d*)\s+(.*)$/)
    if (!m) continue
    const v = (m[2] ?? '').trim().split(/\s+/).map(Number)
    // user nice system idle iowait irq softirq steal
    const idle = (v[3] ?? 0) + (v[4] ?? 0)
    const all = v.slice(0, 8).reduce((a, b) => a + b, 0)
    const t = { busy: all - idle, all }
    if (m[1] === '') total = t
    else cores.push(t)
  }

  return { total, cores }
}

export const pct = (now: CpuTimes, before: CpuTimes | undefined): number => {
  if (!before) return 0
  const all = now.all - before.all

  return all > 0 ? Math.max(0, Math.min(100, ((now.busy - before.busy) / all) * 100)) : 0
}

export const parseMeminfo = (text: string) => {
  const kb = (key: string) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) * 1024
  const memTotal = kb('MemTotal')
  const swapTotal = kb('SwapTotal')

  return {
    memTotal,
    memUsed: memTotal - kb('MemAvailable'),
    swapTotal,
    swapUsed: swapTotal - kb('SwapFree'),
  }
}

// The interface the default route with the lowest metric goes through.
export const defaultIface = (route: string): string | undefined => {
  let best: { iface: string; metric: number } | undefined
  for (const line of route.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f[1] !== '00000000' || f[0] === undefined) continue
    const metric = Number(f[6] ?? 0)
    if (!best || metric < best.metric) best = { iface: f[0], metric }
  }

  return best?.iface
}

export const parseNetDev = (text: string, iface: string): { rx: number; tx: number } | undefined => {
  for (const line of text.split('\n')) {
    const [name, rest] = line.split(':')
    if (name?.trim() !== iface || rest === undefined) continue
    const f = rest.trim().split(/\s+/).map(Number)

    return { rx: f[0] ?? 0, tx: f[8] ?? 0 }
  }

  return undefined
}

// Bytes read and written by whole disks (nvme0n1, sda), partitions left out.
export const parseDiskstats = (text: string): { read: number; write: number } => {
  let read = 0
  let write = 0
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    const name = f[2] ?? ''
    if (!/^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+)$/.test(name)) continue
    read += Number(f[5] ?? 0) * SECTOR
    write += Number(f[9] ?? 0) * SECTOR
  }

  return { read, write }
}

export type ProcTimes = { name: string; ticks: number; rss: number }

// `cat /proc/[0-9]*/stat`: one line per process, "pid (comm) state ...".
export const parseProcStats = (text: string): Map<number, ProcTimes> => {
  const out = new Map<number, ProcTimes>()
  for (const line of text.split('\n')) {
    const open = line.indexOf('(')
    const close = line.lastIndexOf(')')
    if (open < 0 || close < open) continue
    const pid = Number(line.slice(0, open))
    const f = line.slice(close + 2).split(' ')
    // after "(comm) ": state=0 ... utime=11 stime=12 ... rss=21
    const ticks = Number(f[11] ?? 0) + Number(f[12] ?? 0)
    out.set(pid, { name: line.slice(open + 1, close), ticks, rss: Number(f[21] ?? 0) * PAGE })
  }

  return out
}

// Processes grouped by program name, CPU from the tick delta since `before`.
export const groupPrograms = (
  now: Map<number, ProcTimes>,
  before: Map<number, ProcTimes> | undefined,
  seconds: number,
): Program[] => {
  const by = new Map<string, Program>()
  for (const [pid, p] of now) {
    const prev = before?.get(pid)
    const cpu = prev && prev.name === p.name && seconds > 0
      ? Math.max(0, ((p.ticks - prev.ticks) / TICKS / seconds) * 100)
      : 0
    const g = by.get(p.name) ?? { name: p.name, count: 0, cpu: 0, rss: 0 }
    g.count += 1
    g.cpu += cpu
    g.rss += p.rss
    by.set(p.name, g)
  }

  return [...by.values()]
}

// ---- formatting (pure, tested) ----

export const gb = (bytes: number): string => {
  const g = bytes / 1024 ** 3

  return g >= 100 ? g.toFixed(0) : g.toFixed(1)
}

export const rate = (bytesPerSec: number): string => {
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let v = Math.max(0, bytesPerSec)
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }

  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

export const meter = (width: number, percent: number): string => {
  const full = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)

  return '█'.repeat(full) + '░'.repeat(Math.max(0, width - full))
}

export const level = (percent: number): 'success' | 'warning' | 'error' =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success'

export const statusLine = (s: Snapshot): string => {
  const parts = [
    `CPU ${Math.round(s.cpu)}%`,
    `RAM ${gb(s.memUsed)}/${gb(s.memTotal)}G`,
  ]
  if (s.swapTotal > 0 && s.swapUsed / s.swapTotal > 0.5) parts.push(`swap ${Math.round((s.swapUsed / s.swapTotal) * 100)}%`)
  if (s.gpu) parts.push(`GPU ${Math.round(s.gpu.busy)}%`)
  if (s.cpuTemp !== undefined) parts.push(`${Math.round(s.cpuTemp)}°C`)

  return parts.join(' · ')
}

// ---- collection (needs the host) ----

// Counters from the previous sample: rates and CPU shares are deltas.
let prev:
  | {
      at: number
      cpu: { total: CpuTimes; cores: CpuTimes[] }
      net?: { iface: string; rx: number; tx: number }
      io: { read: number; write: number }
      gpuIdleMs?: number
    }
  | undefined
let prevProcs: { at: number; procs: Map<number, ProcTimes> } | undefined
let programs: { topCpu: Program[]; topMem: Program[] } = { topCpu: [], topMem: [] }
let disk: Snapshot['disk']
let hwmon: Record<string, string> | undefined
// The CPU's limit in millidegrees, read once; null when the sensor has none.
let cpuTempMax: number | null | undefined
let ticks = 0

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  return $.fs.read(path).catch(() => undefined)
}

async function readNum($: EngineInterface, path: string): Promise<number | undefined> {
  const t = await readText($, path)
  const n = Number(t?.trim())

  return t === undefined || Number.isNaN(n) ? undefined : n
}

async function findHwmon($: EngineInterface): Promise<Record<string, string>> {
  if (hwmon) return hwmon
  const found: Record<string, string> = {}
  const dirs = await $.fs.list('/sys/class/hwmon').catch(() => [])
  for (const d of dirs) {
    const path = `/sys/class/hwmon/${d.name}`
    const name = (await readText($, `${path}/name`))?.trim()
    if (name && !(name in found)) found[name] = path
  }
  hwmon = found

  return found
}

async function samplePrograms($: EngineInterface) {
  const run = await $.process
    .run(['sh', '-c', 'cat /proc/[0-9]*/stat 2>/dev/null'], { timeoutMs: 5000 })
    .catch(() => undefined)
  if (!run) return
  const at = await $.clock.now()
  const procs = parseProcStats(run.stdout)
  const seconds = prevProcs ? (at - prevProcs.at) / 1000 : 0
  const list = groupPrograms(procs, prevProcs?.procs, seconds)
  prevProcs = { at, procs }
  programs = {
    topCpu: [...list].sort((a, b) => b.cpu - a.cpu).slice(0, 6),
    topMem: [...list].sort((a, b) => b.rss - a.rss).slice(0, 6),
  }
}

async function sampleDisk($: EngineInterface) {
  const run = await $.process
    .run(['df', '-B1', '--output=target,size,used', '/'], { timeoutMs: 5000 })
    .catch(() => undefined)
  const f = run?.stdout.trim().split('\n')[1]?.trim().split(/\s+/)
  if (f && f.length >= 3) disk = { mount: f[0] ?? '/', total: Number(f[1]), used: Number(f[2]) }
}

async function sample($: EngineInterface) {
  ticks += 1
  if ((ticks - 1) % PROCS_EVERY === 0) await samplePrograms($)
  if ((ticks - 1) % DISK_EVERY === 0) await sampleDisk($)

  const at = await $.clock.now()
  const cpu = parseCpu((await readText($, '/proc/stat')) ?? '')
  const mem = parseMeminfo((await readText($, '/proc/meminfo')) ?? '')
  const load = ((await readText($, '/proc/loadavg')) ?? '0 0 0').split(' ').slice(0, 3).map(Number)
  const io = parseDiskstats((await readText($, '/proc/diskstats')) ?? '')
  const iface = defaultIface((await readText($, '/proc/net/route')) ?? '')
  const dev = iface ? parseNetDev((await readText($, '/proc/net/dev')) ?? '', iface) : undefined
  const gpuIdleMs = await readNum($, `${GPU_GT}/gtidle/idle_residency_ms`)
  const gpuMhz = await readNum($, `${GPU_GT}/freq0/act_freq`)

  const hw = await findHwmon($)
  const cpuTemp = hw.coretemp ? await readNum($, `${hw.coretemp}/temp1_input`) : undefined
  if (hw.coretemp && cpuTempMax === undefined)
    cpuTempMax = (await readNum($, `${hw.coretemp}/temp1_max`)) ?? (await readNum($, `${hw.coretemp}/temp1_crit`)) ?? null
  const nvmeTemp = hw.nvme ? await readNum($, `${hw.nvme}/temp1_input`) : undefined
  const fanDir = Object.entries(hw).find(([name]) => name === 'asus' || name.includes('fan'))?.[1]
  const fan = fanDir ? await readNum($, `${fanDir}/fan1_input`) : undefined
  const batPct = await readNum($, '/sys/class/power_supply/BAT0/capacity')
  const batStatus = (await readText($, '/sys/class/power_supply/BAT0/status'))?.trim()

  const seconds = prev ? (at - prev.at) / 1000 : 0
  const per = (now: number, before: number | undefined) =>
    before !== undefined && seconds > 0 ? Math.max(0, (now - before) / seconds) : 0

  const s: Snapshot = {
    at,
    cpu: pct(cpu.total, prev?.cpu.total),
    cores: cpu.cores.map((c, i) => pct(c, prev?.cpu.cores[i])),
    load,
    ...mem,
    gpu:
      gpuIdleMs !== undefined && prev?.gpuIdleMs !== undefined && seconds > 0
        ? {
            busy: Math.max(0, Math.min(100, 100 - ((gpuIdleMs - prev.gpuIdleMs) / (seconds * 1000)) * 100)),
            mhz: gpuMhz ?? 0,
          }
        : undefined,
    disk,
    io: { read: per(io.read, prev?.io.read), write: per(io.write, prev?.io.write) },
    net:
      iface && dev
        ? {
            iface,
            down: per(dev.rx, prev?.net?.iface === iface ? prev.net.rx : undefined),
            up: per(dev.tx, prev?.net?.iface === iface ? prev.net.tx : undefined),
          }
        : undefined,
    cpuTemp: cpuTemp !== undefined ? cpuTemp / 1000 : undefined,
    cpuTempMax: cpuTempMax ? cpuTempMax / 1000 : undefined,
    nvmeTemp: nvmeTemp !== undefined ? nvmeTemp / 1000 : undefined,
    fan,
    battery: batPct !== undefined ? { pct: batPct, status: batStatus ?? '' } : undefined,
    topCpu: programs.topCpu,
    topMem: programs.topMem,
  }

  prev = { at, cpu, io, gpuIdleMs, net: iface && dev ? { iface, ...dev } : undefined }
  latestSnapshot = s
  samples += 1
  await update($, snap, () => s)
}

async function sysmonCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  if ((args ?? '').trim() === 'line') {
    const isOn = !(await read($, isLineOn))
    await update($, isLineOn, () => isOn)
    if (!isOn) $.ui.status(undefined)

    return { text: isOn ? 'System summary line on.' : 'System summary line off.' }
  }
  const opened = await $.ui.open({ id: PANE, title: 'System monitor' })

  return {
    text: opened.isPlaced
      ? 'System monitor opened.'
      : 'This window cannot show side panels; the summary line under the prompt stays on.',
  }
}

// Called from the plugin's one session.start hook (hooks/register.ts).
export async function startSysmon($: EngineInterface): Promise<void> {
  await $.command.register({
    name: 'sysmon',
    description: 'System monitor: open the pane; "line" turns the summary under the prompt on or off',
    argumentHint: '[line]',
  })
  $.clock.every(INTERVAL_MS, () => sample($).catch(() => {}))
}

export function registerSysmon(on: On): void {
  on('command.run', { command: 'sysmon' }, ($, e) => sysmonCommand($, e.args))
  // The same command under the plugin's prefix, as commands/sysmon.md lists it.
  on('command.run', { command: 'rp:sysmon' }, ($, e) => sysmonCommand($, e.args))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snap)
    if (!s) return <Text dimColor>Collecting the first sample…</Text>

    const cols = Math.max(30, e.props.bodyColumns)
    const label = 6
    const bar = Math.max(8, Math.min(30, cols - label - 22))

    const row = (name: string, percent: number, right: string) => (
      <Text key={`row-${name}`} wrap="truncate">
        <Text bold>{name.padEnd(label)}</Text>
        <Text color={level(percent)}>{meter(bar, percent)}</Text>
        <Text> {right}</Text>
      </Text>
    )

    const coreCols = Math.max(1, Math.floor(cols / 14))
    const coreRows: number[][] = []
    s.cores.forEach((c, i) => {
      if (i % coreCols === 0) coreRows.push([])
      coreRows[coreRows.length - 1]?.push(c)
    })

    const memPct = s.memTotal ? (s.memUsed / s.memTotal) * 100 : 0
    const swapPct = s.swapTotal ? (s.swapUsed / s.swapTotal) * 100 : 0
    const diskPct = s.disk && s.disk.total ? (s.disk.used / s.disk.total) * 100 : 0
    const nameWidth = Math.max(8, cols - 22)

    return (
      <Box flexDirection="column">
        {row('CPU', s.cpu, `${Math.round(s.cpu).toString().padStart(3)}%  load ${s.load.map(l => l.toFixed(1)).join(' ')}`)}
        {coreRows.map((row, r) => (
          <Text key={`cores-${r}`} wrap="truncate">
            {'      '}
            {row.map((c, i) => (
              <Text key={`core-${r * coreCols + i}`}>
                <Text dimColor>{String(r * coreCols + i).padStart(2)} </Text>
                <Text color={level(c)}>{meter(5, c)}</Text>
                <Text>{`${Math.round(c)}%`.padStart(5)} </Text>
              </Text>
            ))}
          </Text>
        ))}
        {s.gpu && row('GPU', s.gpu.busy, `${Math.round(s.gpu.busy).toString().padStart(3)}%  ${s.gpu.mhz} MHz`)}
        {row('RAM', memPct, `${gb(s.memUsed)} / ${gb(s.memTotal)} GB`)}
        {s.swapTotal > 0 && row('Swap', swapPct, `${gb(s.swapUsed)} / ${gb(s.swapTotal)} GB`)}
        {s.disk && row('Disk', diskPct, `${gb(s.disk.used)} / ${gb(s.disk.total)} GB`)}
        <Text wrap="truncate">
          {'      '}
          <Text dimColor>read</Text> {rate(s.io.read)}  <Text dimColor>write</Text> {rate(s.io.write)}
        </Text>
        {s.net && (
          <Text wrap="truncate">
            <Text bold>{'Net'.padEnd(label)}</Text>
            <Text dimColor>down</Text> {rate(s.net.down)}  <Text dimColor>up</Text> {rate(s.net.up)}
            <Text dimColor>  ({s.net.iface})</Text>
          </Text>
        )}
        <Text wrap="truncate">
          <Text bold>{'Temp'.padEnd(label)}</Text>
          {s.cpuTemp !== undefined && (
            <Text color={s.cpuTemp >= 95 ? 'error' : s.cpuTemp >= 85 ? 'warning' : 'text'}>
              CPU {Math.round(s.cpuTemp)}°C
            </Text>
          )}
          {s.nvmeTemp !== undefined && <Text>  disk {Math.round(s.nvmeTemp)}°C</Text>}
          {s.fan !== undefined && <Text>  fan {s.fan} rpm</Text>}
        </Text>
        {s.battery && (
          <Text wrap="truncate">
            <Text bold>{'Power'.padEnd(label)}</Text>
            battery {s.battery.pct}% <Text dimColor>({s.battery.status.toLowerCase()})</Text>
          </Text>
        )}
        <Text> </Text>
        <Text bold>Busiest programs</Text>
        {s.topCpu.map(p => (
          <Text key={`cpu-${p.name}`} wrap="truncate">
            {`${Math.round(p.cpu)}%`.padStart(6)}  {p.name.slice(0, nameWidth)}
            <Text dimColor>{p.count > 1 ? ` ×${p.count}` : ''}</Text>
          </Text>
        ))}
        <Text bold>Biggest programs in memory</Text>
        {s.topMem.map(p => (
          <Text key={`mem-${p.name}`} wrap="truncate">
            {`${gb(p.rss)} GB`.padStart(8)}  {p.name.slice(0, nameWidth)}
            <Text dimColor>{p.count > 1 ? ` ×${p.count}` : ''}</Text>
          </Text>
        ))}
      </Box>
    )
  })
}
