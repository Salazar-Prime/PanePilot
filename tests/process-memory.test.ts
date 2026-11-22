import { describe, expect, it } from 'vitest'
import { parseProcessMemory, summarizeProcessMemory, unavailableProcessMemory, type MemoryTopology } from '../src/main/process-memory'

const base = (): MemoryTopology => ({ servers: [10, 10], clients: [11, 11], warning: null,
  sessions: [{ id: 'codex', name: 'Write chapter', detail: 'Book · Codex', roots: [20, 20] },
    { id: 'claude', name: 'Review', detail: 'App · Claude', roots: [30] }] })
const sample = () => parseProcessMemory('10 1 100\n11 2 10\n20 10 1\n21 20 200\n22 21 50\n30 10 300\n40 10 999\n50 21 1000\n51 50 1000')

describe('local process memory accounting', () => {
  it('converts RSS from KiB, validates numeric fields, and bounds reads', () => {
    expect(parseProcessMemory(' 7  1  128\n')).toEqual([{ pid: 7, parent: 1, bytes: 131072 }])
    for (const input of ['1 2 -3', '1 2 4 secret-arguments', '0 1 1', '1 0 9007199254740992', 'bad']) expect(() => parseProcessMemory(input)).toThrow()
    expect(() => parseProcessMemory('1 0 1\n'.repeat(30_001))).toThrow('safety limit')
  })
  it('separates shared tmux memory, sums agent descendants, and excludes unrelated/Electron trees', () => {
    const result = summarizeProcessMemory(base(), sample(), [50])
    expect(result.tmux).toMatchObject({ bytes: 110 * 1024, processCount: 2, warning: null })
    expect(result.agents).toMatchObject({ bytes: 551 * 1024, processCount: 4, warning: null })
    expect(result.agents.rows.map(row => [row.id, row.bytes])).toEqual([['claude', 300 * 1024], ['codex', 251 * 1024]])
  })
  it('counts each PID once in totals even with linked panes or overlapping session trees', () => {
    const topology = base()
    topology.sessions.push({ id: 'linked', name: 'Linked', detail: 'Codex', roots: [21] })
    const result = summarizeProcessMemory(topology, sample(), [50])
    expect(result.agents.processCount).toBe(4)
    expect(result.agents.bytes).toBe(551 * 1024)
  })
  it('distinguishes missing processes from a verified empty snapshot', () => {
    const missing = summarizeProcessMemory(base(), [], [])
    expect(missing.tmux.bytes).toBeNull()
    expect(missing.agents.bytes).toBeNull()
    expect(missing.agents.warning).toContain('could not be measured')
    expect(missing.agents.rows.every(row => row.bytes === null)).toBe(true)
    const empty = summarizeProcessMemory({ servers: [], clients: [], sessions: [], warning: null }, [], [])
    expect(empty.agents).toMatchObject({ bytes: 0, processCount: 0, warning: null })
    expect(unavailableProcessMemory('No access').tmux).toMatchObject({ bytes: null, warning: 'No access' })
  })
  it('returns a known subtotal when only part of the process set remains readable', () => {
    const result = summarizeProcessMemory(base(), parseProcessMemory('10 1 100\n20 10 5'), [])
    expect(result.tmux).toMatchObject({ bytes: 102400, processCount: 1 })
    expect(result.tmux.warning).toBeTruthy()
    expect(result.agents.bytes).toBe(5120)
    expect(result.agents.warning).toContain('subtotal')
  })
  it('bounds visible rows without losing the measured total', () => {
    const sessions = Array.from({ length: 150 }, (_, index) => ({ id: String(index), name: String(index), detail: 'Codex', roots: [index + 100] }))
    const samples = sessions.map((session, index) => ({ pid: session.roots[0], parent: 1, bytes: index + 1 }))
    const result = summarizeProcessMemory({ servers: [], clients: [], sessions, warning: null }, samples, [])
    expect(result.agents).toMatchObject({ bytes: 11325, processCount: 150, omittedRows: 50 })
    expect(result.agents.rows).toHaveLength(100)
    expect(result.agents.rows[0].bytes).toBe(150)
  })
  it('does not loop on a malformed parent cycle', () => {
    expect(summarizeProcessMemory({ ...base(), sessions: [base().sessions[0]] }, parseProcessMemory('20 21 1\n21 20 2'), []).agents.processCount).toBe(2)
  })
})
