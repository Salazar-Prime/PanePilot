// Isolated benchmarks of production desktop services. Never opens the real app/profile.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temp = await mkdtemp(join(tmpdir(), 'panepilot-desktop-benchmark-'))
const destination = process.argv[2] ? resolve(process.argv[2]) : null
try {
  await build({ entryPoints: [join(root, 'scripts/benchmarks/desktop-core.ts')],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external',
    outfile: join(temp, 'benchmark.cjs') })
  let stdout = ''
  const code = await new Promise((done, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'),
      ['--expose-gc', join(temp, 'benchmark.cjs')], {
        cwd: root,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(root, 'node_modules') },
        stdio: ['ignore', 'pipe', 'inherit']
      })
    child.stdout.on('data', data => { stdout += data })
    child.once('error', reject)
    child.once('exit', done)
  })
  if (code !== 0) throw new Error(`Benchmark process exited ${code}`)
  JSON.parse(stdout)
  if (destination) {
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, stdout)
    console.log(`Benchmark results: ${destination}`)
  } else process.stdout.write(stdout)
} finally { await rm(temp, { recursive: true, force: true }) }
