import { describe, expect, mock, test } from 'claude-code/testing'

import {
  defaultIface,
  groupPrograms,
  parseCpu,
  parseDiskstats,
  parseMeminfo,
  parseNetDev,
  parseProcStats,
  pct,
  rate,
  statusLine,
} from './index'

describe('parsers', () => {
  test('cpu share from two /proc/stat samples', async () => {
    const a = parseCpu('cpu  100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\n')
    const b = parseCpu('cpu  200 0 200 900 0 0 0 0\ncpu0 100 0 100 450 0 0 0 0\n')
    expect(Math.round(pct(b.total, a.total))).toBe(67)
    expect(b.cores.length).toBe(1)
  })

  test('memory, route, network and disks', async () => {
    const mem = parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 250 kB\nSwapTotal: 100 kB\nSwapFree: 40 kB\n')
    expect(mem.memUsed).toBe(750 * 1024)
    expect(mem.swapUsed).toBe(60 * 1024)
    const route = 'Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\nvpn\t00000000\t0\t1\t0\t0\t1\nwlo1\t00000000\t1\t3\t0\t0\t600\n'
    expect(defaultIface(route)).toBe('vpn')
    expect(parseNetDev('  vpn: 1000 5 0 0 0 0 0 0 2000 5 0 0 0 0 0 0\n', 'vpn')).toEqual({ rx: 1000, tx: 2000 })
    const io = parseDiskstats(' 259 0 nvme0n1 1 0 10 0 1 0 20 0 0 0 0\n 259 1 nvme0n1p1 1 0 99 0 1 0 99 0 0 0 0\n')
    expect(io).toEqual({ read: 5120, write: 10240 })
  })

  test('programs grouped by name with CPU from tick deltas', async () => {
    const before = parseProcStats('1 (chrome) S 0 0 0 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0 0 0 10\n2 (chrome) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 10\n')
    const now = parseProcStats('1 (chrome) S 0 0 0 0 0 0 0 0 0 0 150 0 0 0 0 0 0 0 0 0 10\n2 (chrome) S 0 0 0 0 0 0 0 0 0 0 50 0 0 0 0 0 0 0 0 0 10\n')
    const [chrome] = groupPrograms(now, before, 1)
    expect(chrome?.count).toBe(2)
    expect(Math.round(chrome?.cpu ?? 0)).toBe(100)
    expect(chrome?.rss).toBe(2 * 10 * 4096)
  })

  test('formats', async () => {
    expect(rate(1536)).toBe('1.5 KB/s')
    expect(
      statusLine({
        at: 0, cpu: 42.4, cores: [], load: [0, 0, 0],
        memTotal: 32 * 1024 ** 3, memUsed: 16 * 1024 ** 3, swapTotal: 16 * 1024 ** 3, swapUsed: 15 * 1024 ** 3,
        io: { read: 0, write: 0 }, cpuTemp: 91.2, topCpu: [], topMem: [],
      }),
    ).toBe('CPU 42% · RAM 16.0/32.0G · swap 94% · 91°C')
  })
})

const FILES: Record<string, string[]> = {
  '/proc/stat': [
    'cpu  100 0 100 800 0 0 0 0\ncpu0 50 0 50 400 0 0 0 0\ncpu1 50 0 50 400 0 0 0 0\n',
    'cpu  300 0 100 1000 0 0 0 0\ncpu0 150 0 50 400 0 0 0 0\ncpu1 150 0 50 600 0 0 0 0\n',
  ],
  '/proc/meminfo': ['MemTotal: 33554432 kB\nMemAvailable: 8388608 kB\nSwapTotal: 16777216 kB\nSwapFree: 1048576 kB\n'],
  '/proc/loadavg': ['2.50 1.75 1.00 3/900 12345\n'],
  '/proc/diskstats': [' 259 0 nvme0n1 1 0 0 0 1 0 0 0 0 0 0\n', ' 259 0 nvme0n1 1 0 2048 0 1 0 4096 0 0 0 0\n'],
  '/proc/net/route': ['Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\nwlo1\t00000000\t1\t3\t0\t0\t600\n'],
  '/proc/net/dev': [' wlo1: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n', ' wlo1: 1048576 0 0 0 0 0 0 0 1024 0 0 0 0 0 0 0\n'],
  '/sys/class/hwmon/hwmon0/name': ['coretemp\n'],
  '/sys/class/hwmon/hwmon0/temp1_input': ['97000\n'],
}

test('the pane draws live numbers on every surface that shows panes', async ($, on) => {
  const clock = mock.clock(on)
  const reads: Record<string, number> = {}
  on('session.start', ($, e) => ({ cwd: e.cwd }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: { tool: 'mcp__rp__resources' } }) as any)
  on('store.get', () => ({ value: undefined }) as any)
  on('store.set', () => ({ value: undefined }) as any)
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.log', () => ({ value: undefined }) as any)
  on('fs.read', ($, e) => {
    const versions = FILES[e.path]
    if (!versions) return { deny: 'missing' } as any
    const n = reads[e.path] ?? 0
    reads[e.path] = n + 1

    return { value: versions[Math.min(n, versions.length - 1)] } as any
  })
  on('fs.list', ($, e) =>
    ({ value: e.path === '/sys/class/hwmon' ? [{ name: 'hwmon0', kind: 'other', size: 0, mtimeMs: 0, isLink: true }] : [] }) as any)
  on('process.run', ($, e) => {
    const isDf = e.argv[0] === 'df'
    const stdout = isDf
      ? 'Mounted on 1B-blocks Used\n/ 1000000000000 850000000000\n'
      : '10 (chrome) S 0 0 0 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0 0 0 1000\n11 (chrome) S 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1000\n'

    return { value: { exitCode: 0, stdout, stderr: '' } } as any
  })

  await $.session.start({ source: 'startup', cwd: '/tmp' } as any)
  await clock.advance(1000)
  await clock.advance(1000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'rp',
      surface,
      component: 'Pane',
      requestId: 'sysmon',
      props: { title: 'System monitor', isFocused: false, bodyColumns: 80, placement: 'dock' } as any,
    })
    expect(await ui.find({ type: 'Text', text: /load 2\.5 1\.8 1\.0/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /24\.0 \/ 32\.0 GB/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CPU 97°C/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /chrome/ })).toBeDefined()
    await ui.unmount()
  }
})
