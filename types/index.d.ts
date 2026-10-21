// Raw Plugin's type contract: the values its modules keep in `$.state`.

export type Program = {
  name: string
  // how many processes run under this name
  count: number
  // percent of one core, summed over the processes
  cpu: number
  // resident memory in bytes, summed over the processes
  rss: number
}

export type Snapshot = {
  at: number
  cpu: number
  cores: number[]
  load: number[]
  memTotal: number
  memUsed: number
  swapTotal: number
  swapUsed: number
  gpu?: { busy: number; mhz: number }
  disk?: { mount: string; used: number; total: number }
  io: { read: number; write: number }
  net?: { iface: string; down: number; up: number }
  cpuTemp?: number
  // The CPU's own limit (°C) as the sensor reports it, when it does.
  cpuTempMax?: number
  nvmeTemp?: number
  fan?: number
  battery?: { pct: number; status: string }
  topCpu: Program[]
  topMem: Program[]
}

// What the team pane draws in the lead's session: the roles with their last
// state and the board text.
export type TeamView = {
  slug: string
  goal: string
  roles: { name: string; isStarted: boolean; isActive: boolean; context?: number; lastAt?: string }[]
  board: string
}

declare module 'claude-code' {
  interface PluginState {
    rp: { snap: Snapshot | null; isLineOn: boolean; team: TeamView | null }
  }
}
