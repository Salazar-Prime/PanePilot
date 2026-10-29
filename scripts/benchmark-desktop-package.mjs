#!/usr/bin/env node
// Read-only package inspection. It does not build, sign, install, or publish an app.
// Usage: node scripts/benchmark-desktop-package.mjs [app-path] [--output report.json]
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const args = process.argv.slice(2)
let appArgument = 'release/mac-arm64/PanePilot.app'
let outputArgument
let sawAppArgument = false
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--output' && args[index + 1]) outputArgument = args[++index]
  else if (!args[index].startsWith('-') && !sawAppArgument) {
    appArgument = args[index]
    sawAppArgument = true
  } else throw new Error('Usage: node scripts/benchmark-desktop-package.mjs [app-path] [--output report.json]')
}

const cwd = process.cwd()
const appPath = resolve(appArgument)
const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar')
if (!existsSync(asarPath)) throw new Error('The requested application has no Contents/Resources/app.asar.')
function portablePath(path) {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
    ? rel.split(sep).join('/') : basename(path)
}
function allocatedBytes(path) {
  if (!existsSync(path)) return null
  const result = spawnSync('du', ['-sk', resolve(path)], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const kib = Number(result.stdout.trim().split(/\s+/)[0])
  return Number.isFinite(kib) ? kib * 1024 : null
}
async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
function directoryFiles(root) {
  const files = []
  if (!existsSync(root)) return files
  const pending = [root]
  while (pending.length) {
    const directory = pending.pop()
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile()) files.push({ path: relative(root, path).split(sep).join('/'), bytes: statSync(path).size })
    }
  }
  return files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path))
}

const groups = new Map()
const entries = []
function walkAsar(node, parent = '') {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = parent ? `${parent}/${name}` : name
    if (value.files) { walkAsar(value, path); continue }
    const parts = path.split('/')
    const groupName = parts[0] === 'node_modules'
      ? parts.slice(0, parts[1].startsWith('@') ? 3 : 2).join('/')
      : parts.slice(0, 2).join('/')
    const group = groups.get(groupName) ?? { path: groupName, files: 0, logicalBytes: 0, packedBytes: 0, unpackedBytes: 0 }
    const bytes = value.size ?? 0
    group.files += 1
    group.logicalBytes += bytes
    group[value.unpacked ? 'unpackedBytes' : 'packedBytes'] += bytes
    groups.set(groupName, group)
    entries.push({ path, logicalBytes: bytes, unpacked: Boolean(value.unpacked) })
  }
}
walkAsar(asar.getRawHeader(asarPath).header)
const groupTable = [...groups.values()].sort((a, b) => b.logicalBytes - a.logicalBytes || a.path.localeCompare(b.path))
const packagedPackage = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
const repositoryPackage = JSON.parse(readFileSync('package.json', 'utf8'))
const mainSource = asar.extractFile(asarPath, 'out/main/index.js').toString('utf8')
const mainExternalPackages = [...new Set(
  [...mainSource.matchAll(/(?:\bfrom\s*|\bimport\(\s*|\brequire\d*\(\s*)["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((specifier) => !specifier.startsWith('node:') && !specifier.startsWith('.') && specifier !== 'electron' && !['AppKit', 'PDFKit'].includes(specifier))
)].sort()
const candidateNames = [
  '@monaco-editor/react', '@xterm/addon-fit', '@xterm/xterm', 'monaco-editor',
  'pdfjs-dist', 'canvas', 'dompurify', 'github-slugger', 'highlight.js', 'lucide-react',
  'marked', 'motion', 'framer-motion', 'motion-dom', 'motion-utils', 'react', 'react-dom', 'scheduler'
]
const candidateGroups = candidateNames.map((name) => groups.get(`node_modules/${name}`)).filter(Boolean)
const runtimeGroups = mainExternalPackages.map((name) => groups.get(`node_modules/${name}`)).filter(Boolean)
const sum = (items, key) => items.reduce((total, item) => total + item[key], 0)
const frameworks = join(appPath, 'Contents', 'Frameworks')
const sourcePaths = [
  'src/main/store.ts', 'src/main/conversation-indexer.ts', 'src/main/remote-conversation-indexer.ts',
  'src/main/codex-subagents.ts', 'src/main/terminal-manager.ts', 'src/main/latex-project-service.ts',
  'src/main/index.ts', 'src/renderer/src/components/App.tsx',
  'src/renderer/src/components/FilesPanel.tsx', 'src/renderer/src/components/LatexPdfPreview.tsx',
  'src/renderer/src/components/ChatHistoryPanel.tsx'
]
const revisionResult = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' })
const outFiles = directoryFiles(resolve('out'))
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  method: 'Read existing ASAR header and package metadata; SHA-256 streamed from app.asar; allocated disk sizes from du -sk. No application run or package build.',
  host: { platform: process.platform, arch: process.arch, node: process.version },
  repository: { head: revisionResult.status === 0 ? revisionResult.stdout.trim() : null, version: repositoryPackage.version },
  artifact: {
    path: portablePath(appPath), version: packagedPackage.version,
    productName: packagedPackage.productName, packageName: packagedPackage.name,
    asar: { path: portablePath(asarPath), modifiedAt: statSync(asarPath).mtime.toISOString(), bytes: statSync(asarPath).size, sha256: await sha256(asarPath) },
    allocatedBytes: allocatedBytes(appPath),
    resourcesAllocatedBytes: allocatedBytes(join(appPath, 'Contents', 'Resources')),
    unpackedAllocatedBytes: allocatedBytes(`${asarPath}.unpacked`),
    frameworksAllocatedBytes: allocatedBytes(frameworks),
    frameworkComponents: existsSync(frameworks) ? readdirSync(frameworks).map((name) => ({ name, allocatedBytes: allocatedBytes(join(frameworks, name)) })).sort((a, b) => b.allocatedBytes - a.allocatedBytes) : [],
    entryCount: entries.length,
    logicalEntryBytes: sum(groupTable, 'logicalBytes'),
    packedLogicalEntryBytes: sum(groupTable, 'packedBytes'),
    unpackedLogicalEntryBytes: sum(groupTable, 'unpackedBytes'),
    groups: groupTable,
    largestEntries: entries.sort((a, b) => b.logicalBytes - a.logicalBytes).slice(0, 30)
  },
  packagingCandidates: {
    explanation: 'These renderer dependencies already have code/assets in out/renderer. Their extra node_modules copies are exclusion candidates, not measured savings. canvas is a native optional PDF.js dependency; the desktop uses PDF.js in Chromium. Rebuild and smoke-test editor workers, PDF rendering, terminal native helpers, and updates before removing anything.',
    modules: candidateGroups,
    logicalBytes: sum(candidateGroups, 'logicalBytes'),
    packedBytes: sum(candidateGroups, 'packedBytes'),
    unpackedBytes: sum(candidateGroups, 'unpackedBytes'),
    mainExternalPackages,
    minimumRequiredRuntimeRootModules: runtimeGroups,
    requiredRuntimeRootLogicalBytes: sum(runtimeGroups, 'logicalBytes'),
    minimumCaveat: 'Runtime roots are a lower bound, not a dependency closure. Keep their required transitive packages, Electron, native helpers, Sparkle framework, and licenses. Logical ASAR bytes differ from filesystem allocation and compressed download size.'
  },
  developmentFiles: {
    explanation: 'These workspace build/dependency/release directories are not all shipped inside the app. No files were removed.',
    outAllocatedBytes: allocatedBytes(resolve('out')),
    outLogicalBytes: sum(outFiles, 'bytes'),
    outLargestFiles: outFiles.slice(0, 20),
    nodeModulesAllocatedBytes: allocatedBytes(resolve('node_modules')),
    releaseAllocatedBytes: allocatedBytes(resolve('release'))
  },
  sourceMetrics: sourcePaths.filter(existsSync).map((path) => {
    const source = readFileSync(path, 'utf8')
    return { path, bytes: Buffer.byteLength(source), lines: source.split('\n').length - (source.endsWith('\n') ? 1 : 0) }
  })
}
const serialized = `${JSON.stringify(report, null, 2)}\n`
if (outputArgument) {
  mkdirSync(dirname(resolve(outputArgument)), { recursive: true })
  writeFileSync(outputArgument, serialized)
  process.stdout.write(`Saved ${portablePath(resolve(outputArgument))}\n`)
} else process.stdout.write(serialized)
