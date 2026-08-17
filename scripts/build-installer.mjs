#!/usr/bin/env node
/**
 * Builds the distributable Windows installer.
 *
 * Why this wrapper exists: `electron-builder` cannot run on Node < 20.19,
 * because `app-builder-lib` `require()`s the ESM-only `@noble/hashes` while
 * generating the update blockmap. Rather than force a system-wide Node upgrade
 * — which would affect every other project on the machine — this fetches a
 * verified portable Node into `.tools/` (gitignored) and runs the build with
 * it. The global Node install is never touched; deleting `.tools/` undoes
 * everything.
 *
 * On a machine already running Node >= 20.19 this does nothing special and
 * simply shells out to electron-builder.
 *
 *   node scripts/build-installer.mjs            # NSIS installer
 *   node scripts/build-installer.mjs --dir      # unpacked folder only
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { join, resolve } from 'node:path'

const NODE_VERSION = 'v24.19.0' // current LTS at time of writing
const MIN_MAJOR = 20
const MIN_MINOR = 19

const root = resolve(import.meta.dirname, '..')
const toolsDir = join(root, '.tools')

function nodeIsNewEnough() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)
}

async function fetchPortableNode() {
  const name = `node-${NODE_VERSION}-win-x64`
  const dir = join(toolsDir, name)
  if (existsSync(join(dir, 'node.exe'))) {
    console.log(`using cached portable node: ${dir}`)
    return dir
  }

  mkdirSync(toolsDir, { recursive: true })
  const zipPath = join(toolsDir, `${name}.zip`)

  if (!existsSync(zipPath)) {
    console.log(`downloading ${name} from nodejs.org…`)
    const res = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/${name}.zip`)
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath))
  }

  // Never extract an archive we have not verified against the official sums.
  console.log('verifying checksum…')
  const sums = await (await fetch(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`)).text()
  const expected = sums
    .split('\n')
    .find((l) => l.includes(`${name}.zip`))
    ?.trim()
    .split(/\s+/)[0]
  const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  if (!expected || expected !== actual) {
    throw new Error(`checksum mismatch for ${name}.zip — refusing to extract`)
  }
  console.log('checksum ok')

  // PowerShell's Expand-Archive avoids adding an unzip dependency.
  const unzip = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${toolsDir}' -Force`],
    { stdio: 'inherit' }
  )
  if (unzip.status !== 0) throw new Error('extraction failed')
  return dir
}

const builderArgs = ['electron-builder', '--win', ...process.argv.slice(2), '--publish', 'never']

if (nodeIsNewEnough()) {
  console.log(`node ${process.versions.node} is new enough — building directly`)
  const r = spawnSync('npx', builderArgs, { cwd: root, stdio: 'inherit', shell: true })
  process.exit(r.status ?? 1)
}

console.log(
  `node ${process.versions.node} cannot run electron-builder (needs >= ${MIN_MAJOR}.${MIN_MINOR}); using portable node`
)
const nodeDir = await fetchPortableNode()
const result = spawnSync('npx', builderArgs, {
  cwd: root,
  stdio: 'inherit',
  shell: true,
  // Prepend for this child process only; the machine's PATH is unchanged.
  env: { ...process.env, Path: `${nodeDir};${process.env.Path ?? ''}` },
})
process.exit(result.status ?? 1)
