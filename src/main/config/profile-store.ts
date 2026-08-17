/**
 * Encrypted at-rest storage for the candidate profile.
 *
 * The profile went from optional garnish to the engine behind every answer, so
 * re-typing it each session was unacceptable friction — but it contains a
 * resume, which is exactly the kind of data that must not sit on disk in plain
 * text. Same treatment as API keys: `safeStorage` (DPAPI on Windows, scoped to
 * the logged-in user), one file in `userData`, deleted the moment the user
 * clears the profile. It never leaves the machine.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import { createLogger } from '@main/core/logger'
import { EMPTY_PROFILE, type CandidateProfile } from '@shared/types'

const log = createLogger('profile-store')

const storePath = (): string => join(app.getPath('userData'), 'profile.enc.json')

function isEmpty(profile: CandidateProfile): boolean {
  return Object.values(profile).every((value) => !String(value).trim())
}

export function loadProfile(): CandidateProfile {
  const path = storePath()
  if (!existsSync(path)) return { ...EMPTY_PROFILE }
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('OS encryption unavailable; stored profile cannot be read')
    return { ...EMPTY_PROFILE }
  }
  try {
    const decrypted = safeStorage.decryptString(readFileSync(path))
    const parsed = JSON.parse(decrypted) as Partial<CandidateProfile>
    // Merge over EMPTY_PROFILE so fields added in later versions default to ''.
    const profile: CandidateProfile = { ...EMPTY_PROFILE }
    for (const key of Object.keys(EMPTY_PROFILE) as Array<keyof CandidateProfile>) {
      const value = parsed[key]
      if (typeof value === 'string') profile[key] = value
    }
    log.info('profile loaded from encrypted store')
    return profile
  } catch (err) {
    // A corrupt or foreign-user file is not worth crashing over.
    log.warn('stored profile unreadable; starting empty', err)
    return { ...EMPTY_PROFILE }
  }
}

export function saveProfile(profile: CandidateProfile): void {
  // An emptied profile means "forget me" — remove the file rather than
  // persisting a blob of blanks.
  if (isEmpty(profile)) {
    deleteProfile()
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('OS encryption unavailable; profile kept in memory only')
    return
  }
  try {
    const path = storePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, safeStorage.encryptString(JSON.stringify(profile)), { mode: 0o600 })
    log.debug('profile persisted (encrypted)')
  } catch (err) {
    log.warn('could not persist profile; it remains in memory for this session', err)
  }
}

export function deleteProfile(): void {
  try {
    if (existsSync(storePath())) {
      unlinkSync(storePath())
      log.info('profile store deleted')
    }
  } catch (err) {
    log.warn('could not delete profile store', err)
  }
}
