import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const execute = promisify(execFile)

export async function runSshBenchmarks() {
  const root = await mkdtemp(join(tmpdir(), 'panepilot-ssh-benchmark-'))
  try {
    // This fixture never executes a real SSH binary. Only the isolated worker
    // receives the temporary PATH; the benchmark caller's environment is intact.
    await writeFile(join(root, 'ssh'), `#!/bin/sh
/bin/sleep 0.2
payload=$(/bin/cat)
case "$payload" in
  *'"root":'*) printf '[]\\n' ;;
  *) printf '{"currentPath":"/fixture","parentPath":"/","entries":[]}\\n' ;;
esac
`, { mode: 0o700 })
    const worker = join(root, 'worker.cjs')
    await build({
      stdin: {
        contents: `
          import assert from 'node:assert/strict'
          import { listRemoteFolders, listRemoteFilesAsync } from './src/main/remote-file-service'
          const round = n => Number(n.toFixed(3))
          async function measure(mode, repetition) {
            const before = process.cpuUsage()
            const started = performance.now()
            const timer = new Promise(resolve => setTimeout(() => resolve(performance.now() - started), 0))
            const result = mode === 'sync-folder-browser'
              ? listRemoteFolders('fixture-only', '/fixture')
              : await listRemoteFilesAsync('fixture-only', '/fixture')
            const wallMs = performance.now() - started
            const cpu = process.cpuUsage(before)
            const timerDelayMs = await timer
            if (mode === 'sync-folder-browser') assert.equal(result.currentPath, '/fixture')
            else assert.deepEqual(result, [])
            return { mode, repetition, wallMs: round(wallMs), timerDelayMs: round(timerDelayMs),
              workerCpuMs: round((cpu.user + cpu.system) / 1000) }
          }
          async function main() {
            const samples = []
            for (let repetition = 1; repetition <= 5; repetition++) {
              for (const mode of repetition % 2 ? ['sync-folder-browser', 'async-file-browser'] : ['async-file-browser', 'sync-folder-browser']) {
                samples.push(await measure(mode, repetition))
              }
            }
            process.stdout.write(JSON.stringify({ samples }) + '\\n')
          }
          main().catch(error => { console.error(error); process.exitCode = 1 })
        `,
        loader: 'ts', resolveDir: process.cwd()
      },
      outfile: worker, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent'
    })
    const { stdout } = await execute(process.execPath, [worker], {
      env: { ...process.env, PATH: root, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 20_000, maxBuffer: 1024 * 1024
    })
    const result = JSON.parse(stdout) as { samples: Array<{ mode: string; timerDelayMs: number }> }
    assert.equal(result.samples.length, 10)
    return {
      name: 'ssh-main-loop-responsiveness',
      method: 'Actual listRemoteFolders versus listRemoteFilesAsync with a fake SSH executable sleeping 200 ms; isolated worker, alternating order, five trials each.',
      limitations: [
        'The two operations have different payloads; this compares existing synchronous/asynchronous execution paths, not a proposed optimization.',
        'Timer delay is a zero-delay callback in the worker, not a measured app frame or end-to-end user latency.',
        'Fixed artificial latency excludes SSH connection overhead, actual networks, and remote Python work.',
        'Worker CPU excludes the fake child process; no watts or battery drain measured.'
      ],
      ...result
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
