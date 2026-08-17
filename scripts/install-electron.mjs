#!/usr/bin/env node
/**
 * Fetches the Electron binary.
 *
 * Why this exists: Electron's own `install.js` is CommonJS and `require()`s
 * `@electron/get`, which is ESM-only. `require(esm)` only became available in
 * Node 20.19 / 22.12, so on an older Node 20 the stock postinstall dies with
 * ERR_REQUIRE_ESM and leaves `node_modules/electron` without a binary — which
 * surfaces later as the unhelpful "Error: Electron uninstall".
 *
 * This is the same logic as the upstream installer, with the two dependencies
 * pulled in via dynamic `import()` instead. It uses the official downloader, so
 * checksum verification and the shared download cache still apply.
 *
 * It can be deleted once the toolchain is on Node >= 20.19.
 */

import { createRequire } from 'node:module'
import { existsSync, readFileSync, renameSync, promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const electronDir = dirname(require.resolve('electron/package.json'))
const { version } = require('electron/package.json')

function platformPath() {
  const platform = process.env.npm_config_platform || os.platform()
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron'
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron'
    case 'win32':
      return 'electron.exe'
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`)
  }
}

const target = platformPath()

function alreadyInstalled() {
  try {
    const installed = readFileSync(join(electronDir, 'dist', 'version'), 'utf-8').replace(/^v/, '')
    if (installed !== version) return false
    if (readFileSync(join(electronDir, 'path.txt'), 'utf-8') !== target) return false
  } catch {
    return false
  }
  return existsSync(join(electronDir, 'dist', target))
}

if (alreadyInstalled()) {
  console.log(`electron ${version} already present`)
  process.exit(0)
}

console.log(`downloading electron ${version} for ${process.platform}/${process.arch}…`)

const { downloadArtifact } = await import('@electron/get')
const { extract } = await import('@electron-internal/extract-zip')

const zipPath = await downloadArtifact({
  version,
  artifactName: 'electron',
  force: process.env.force_no_cache === 'true',
  cacheRoot: process.env.electron_config_cache,
  checksums: require('electron/checksums.json'),
  platform: process.env.npm_config_platform || process.platform,
  arch: process.env.npm_config_arch || process.arch,
})

const distPath = join(electronDir, 'dist')
await extract(zipPath, { dir: distPath })

// The zip ships type definitions one level too deep.
const srcTypes = join(distPath, 'electron.d.ts')
if (existsSync(srcTypes)) renameSync(srcTypes, join(electronDir, 'electron.d.ts'))

await fsp.writeFile(join(electronDir, 'path.txt'), target)
console.log(`electron ${version} installed → dist/${target}`)
