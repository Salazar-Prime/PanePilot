// Isolated before/after archive benchmark. Never reads the user's provider archives.
import { build } from 'esbuild'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  if (index < 0) return null
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`)
  return args[index + 1]
}
// The completed first optimization pass is the reproducible comparison source.
const baselineRef = option('--baseline-ref') ?? '8022d4dcbee44b71b1218f8d0775714ed122997a'
const destination = option('--output')
const smoke = args.includes('--smoke')
const git = (...gitArgs) => execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8' }).trim()
const baselineCommit = git('rev-parse', '--verify', `${baselineRef}^{commit}`)
const baselineSource = execFileSync('git', ['show', `${baselineCommit}:src/main/conversation-indexer.ts`], { cwd: root, encoding: 'utf8' })
const temp = await mkdtemp(join(tmpdir(), 'panepilot-archive-benchmark-'))
try {
  const config = { bundle: true, platform: 'node', format: 'cjs', packages: 'external' }
  await build({ ...config, stdin: { contents: baselineSource, loader: 'ts',
    resolveDir: join(root, 'src/main'), sourcefile: 'conversation-indexer-baseline.ts' },
    outfile: join(temp, 'baseline.cjs') })
  await build({ ...config, entryPoints: [join(root, 'src/main/conversation-indexer-worker.ts')],
    // GC is diagnostic-only, before an untimed diagnostics request. All measured
    // list/search work runs through the unchanged production worker handler.
    banner: { js: "if (typeof global.gc !== 'function') throw new Error('Archive benchmark requires --expose-gc in its worker.'); require('node:worker_threads').parentPort.on('message', request => { if (request.method === 'diagnostics') global.gc(); });" },
    outfile: join(temp, 'worker.cjs') })
  await build({ ...config, entryPoints: [join(root, 'scripts/benchmarks/conversation-archives.ts')],
    outfile: join(temp, 'benchmark.cjs') })
  const sourceFiles = ['src/main/conversation-indexer.ts', 'src/main/conversation-indexer-client.ts',
    'src/main/conversation-indexer-worker.ts', 'src/shared/conversation-hierarchy.ts',
    'src/shared/conversation-messages.ts', 'src/main/codex-subagents.ts']
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async path =>
    [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
  const provenance = { sourceCommit: git('rev-parse', 'HEAD'), baselineCommit,
    trackedWorkingTreeDirty: Boolean(git('status', '--porcelain', '--untracked-files=no')),
    sourceSha256: sourceHashes,
    baselineIndexerSha256: createHash('sha256').update(baselineSource).digest('hex') }
  let stdout = ''
  const code = await new Promise((done, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'),
      ['--expose-gc', join(temp, 'benchmark.cjs'), join(temp, 'baseline.cjs'), join(temp, 'worker.cjs'), smoke ? 'smoke' : 'full'], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_PATH: join(root, 'node_modules'),
          PANEPILOT_ARCHIVE_BENCHMARK_PROVENANCE: JSON.stringify(provenance) },
        stdio: ['ignore', 'pipe', 'inherit']
      })
    child.stdout.on('data', data => { stdout += data })
    child.once('error', reject)
    child.once('exit', done)
  })
  if (code !== 0) throw new Error(`Archive benchmark exited ${code}`)
  JSON.parse(stdout)
  if (destination) {
    const output = resolve(destination)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, stdout)
    console.log(`Archive benchmark results: ${output}`)
  } else process.stdout.write(stdout)
} finally { await rm(temp, { recursive: true, force: true }) }
