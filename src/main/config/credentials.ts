/**
 * Credential resolution and storage.
 *
 * Resolution order (first hit wins):
 *   1. the OS-encrypted store  (written from the UI, survives restarts)
 *   2. `process.env`           (CI / launcher scripts)
 *   3. a `.env` file next to the app root (development convenience)
 *
 * At rest, keys are encrypted with Electron's `safeStorage`, which on Windows
 * is DPAPI scoped to the logged-in user — a plain JSON settings file would leave
 * them readable by anything running as that user.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { app, safeStorage } from 'electron'
import { createLogger, registerSecret } from '@main/core/logger'
import type { CredentialStatus } from '@shared/types'

const log = createLogger('credentials')

export const CREDENTIAL_KEYS = [
  'DEEPGRAM_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const

export type CredentialKey = (typeof CREDENTIAL_KEYS)[number]

let dotenvCache: Record<string, string> | null = null

/** Small `.env` parser — avoids a dependency and does exactly what we need. */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

function loadDotenv(): Record<string, string> {
  if (dotenvCache) return dotenvCache
  dotenvCache = {}
  // In dev, cwd is the project root. In a packaged build there is no .env and
  // this is simply a miss.
  const candidates = [join(process.cwd(), '.env'), join(app.getAppPath(), '.env')]
  for (const path of candidates) {
    try {
      if (!existsSync(path)) continue
      dotenvCache = { ...parseDotenv(readFileSync(path, 'utf8')), ...dotenvCache }
      log.info(`loaded .env from ${path}`)
    } catch (err) {
      log.warn('failed reading .env', err)
    }
  }
  return dotenvCache
}

// ---------------------------------------------------------------------------
// Encrypted store
// ---------------------------------------------------------------------------

const storePath = (): string => join(app.getPath('userData'), 'credentials.enc.json')

type EncryptedBlob = Record<string, string>

let encryptedCache: Partial<Record<CredentialKey, string>> | null = null

function readEncrypted(): Partial<Record<CredentialKey, string>> {
  if (encryptedCache) return encryptedCache
  encryptedCache = {}
  const path = storePath()
  if (!existsSync(path)) return encryptedCache
  try {
    const blob = JSON.parse(readFileSync(path, 'utf8')) as EncryptedBlob
    const available = safeStorage.isEncryptionAvailable()
    for (const key of CREDENTIAL_KEYS) {
      const enc = blob[key]
      if (!enc) continue
      if (!available) {
        log.warn('OS encryption unavailable; stored credentials cannot be read')
        break
      }
      try {
        encryptedCache[key] = safeStorage.decryptString(Buffer.from(enc, 'base64'))
      } catch {
        log.warn(`could not decrypt stored ${key} — ignoring it`)
      }
    }
  } catch (err) {
    log.warn('credential store unreadable; ignoring', err)
  }
  return encryptedCache
}

function writeEncrypted(values: Partial<Record<CredentialKey, string>>): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level encryption is unavailable, so API keys cannot be stored securely. ' +
        'Use environment variables or a .env file instead.'
    )
  }
  const blob: EncryptedBlob = {}
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue
    blob[key] = safeStorage.encryptString(value).toString('base64')
  }
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(blob), { encoding: 'utf8', mode: 0o600 })
  encryptedCache = { ...values }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function getCredential(key: CredentialKey): string | undefined {
  const value = readEncrypted()[key] || process.env[key] || loadDotenv()[key]
  const trimmed = value?.trim()
  if (trimmed) registerSecret(trimmed)
  return trimmed || undefined
}

export function setCredentials(updates: Record<string, string>): void {
  const current = { ...readEncrypted() }
  for (const [key, value] of Object.entries(updates)) {
    if (!CREDENTIAL_KEYS.includes(key as CredentialKey)) continue
    const trimmed = value.trim()
    if (trimmed) {
      current[key as CredentialKey] = trimmed
      registerSecret(trimmed)
    } else {
      delete current[key as CredentialKey]
    }
  }
  writeEncrypted(current)
  log.info('credential store updated', { keys: Object.keys(current) })
}

export function credentialStatus(): CredentialStatus {
  return {
    deepgram: Boolean(getCredential('DEEPGRAM_API_KEY')),
    groq: Boolean(getCredential('GROQ_API_KEY')),
    openrouter: Boolean(getCredential('OPENROUTER_API_KEY')),
    openai: Boolean(getCredential('OPENAI_API_KEY')),
    anthropic: Boolean(getCredential('ANTHROPIC_API_KEY')),
  }
}

/** Pre-register every known key so the logger can redact it from day one. */
export function primeRedaction(): void {
  for (const key of CREDENTIAL_KEYS) getCredential(key)
}
