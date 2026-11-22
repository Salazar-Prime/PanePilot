import type { ProcessMemoryGroup, ProcessMemoryRow } from '../shared/powerSaving'

export interface MemorySession { id: string; name: string; detail: string; roots: number[] }
export interface MemoryTopology { servers: number[]; clients: number[]; sessions: MemorySession[]; warning: string | null }
export interface ProcessSample { pid: number; parent: number; bytes: number }

// Numeric fields only: never collect command arguments, environment or prompts.
export function parseProcessMemory(text: string): ProcessSample[] {
  const lines = text.trim() ? text.trim().split('\n') : []
  if (lines.length > 30_000) throw new Error('Process snapshot exceeds its safety limit.')
  const result = new Map<number, ProcessSample>()
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
    if (!match) throw new Error('Process snapshot is incomplete.')
    const [pid, parent, kib] = match.slice(1).map(Number)
    if (pid < 1 || ![pid, parent, kib * 1024].every(Number.isSafeInteger)) throw new Error('Invalid process measurement.')
    result.set(pid, { pid, parent, bytes: kib * 1024 })
  }
  return [...result.values()]
}

export function unavailableProcessMemory(message: string): { tmux: ProcessMemoryGroup; agents: ProcessMemoryGroup } {
  const group = (): ProcessMemoryGroup => ({ bytes: null, processCount: 0, rows: [], omittedRows: 0, warning: message })
  return { tmux: group(), agents: group() }
}

export function summarizeProcessMemory(topology: MemoryTopology, samples: ProcessSample[], electronPids: number[]) {
  const processes = new Map(samples.map(item => [item.pid, item]))
  const children = new Map<number, number[]>()
  for (const item of samples) {
    const siblings = children.get(item.parent) ?? []
    siblings.push(item.pid)
    children.set(item.parent, siblings)
  }
  const excluded = new Set(electronPids)
  const tmuxPids = new Set([...topology.servers, ...topology.clients].filter(pid => !excluded.has(pid)))
  const agentPids = new Set<number>()
  const sum = (pids: Set<number>) => [...pids].reduce((total, pid) => total + (processes.get(pid)?.bytes ?? 0), 0)
  const tmuxRows: ProcessMemoryRow[] = [...tmuxPids].map(pid => ({ id: String(pid),
    name: topology.servers.includes(pid) ? 'Shared tmux server' : 'Attached tmux client', detail: `PID ${pid}`,
    bytes: processes.get(pid)?.bytes ?? null, processCount: processes.has(pid) ? 1 : 0 }))
  let missingRoots = 0
  const agentRows: ProcessMemoryRow[] = topology.sessions.map(session => {
    const seen = new Set<number>()
    const queue = [...new Set(session.roots)]
    const missing = queue.filter(pid => !processes.has(pid)).length
    missingRoots += missing
    for (let index = 0; index < queue.length; index++) {
      const pid = queue[index]
      if (seen.has(pid) || excluded.has(pid) || tmuxPids.has(pid) || !processes.has(pid)) continue
      seen.add(pid); agentPids.add(pid)
      queue.push(...children.get(pid) ?? [])
    }
    return { id: session.id, name: session.name, detail: session.detail,
      bytes: !seen.size && missing ? null : sum(seen), processCount: seen.size }
  })
  const group = (rows: ProcessMemoryRow[], pids: Set<number>, warning: string | null): ProcessMemoryGroup => {
    const known = new Set([...pids].filter(pid => processes.has(pid)))
    const sorted = rows.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name))
    return { bytes: warning && !known.size ? null : sum(known), processCount: known.size,
      rows: sorted.slice(0, 100), omittedRows: Math.max(0, rows.length - 100), warning }
  }
  return {
    tmux: group(tmuxRows, tmuxPids, topology.warning || (tmuxRows.some(row => row.bytes == null) ? 'Some tmux processes exited or could not be measured.' : null)),
    agents: group(agentRows, agentPids, topology.warning || (missingRoots ? 'Some session processes exited or could not be measured; showing the known subtotal.' : null))
  }
}
