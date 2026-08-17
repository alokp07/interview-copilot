/**
 * Application settings: validated with zod, persisted as plain JSON in
 * `userData`. Deliberately holds no secrets — those live in `credentials.ts`
 * behind OS encryption.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { createLogger } from '@main/core/logger'
import type { AppSettings } from '@shared/types'

const log = createLogger('settings')

const providerSettings = z.object({
  sttProvider: z.string().default('deepgram-flux'),
  llmProvider: z.string().default('groq'),
  // Measured ~380 ms to first token warm, with `reasoning_effort: low`.
  llmModel: z.string().default('openai/gpt-oss-20b'),
  // Deepgram's documented ranges. 0.4 buys ~150–250 ms of head start over the
  // confirmed end-of-turn, at the cost of some discarded generations.
  eagerEotThreshold: z.number().min(0.3).max(0.9).default(0.4),
  eotThreshold: z.number().min(0.5).max(0.9).default(0.7),
  eotTimeoutMs: z.number().int().min(1000).max(20_000).default(4000),
})

const uiSettings = z.object({
  alwaysOnTop: z.boolean().default(true),
  contentProtection: z.boolean().default(true),
  opacity: z.number().min(0.25).max(1).default(1),
  showTranscript: z.boolean().default(true),
  showLatency: z.boolean().default(true),
})

const sessionSettings = z.object({
  mode: z
    .enum(['general', 'technical', 'behavioral', 'system-design', 'coding', 'hr'])
    .default('general'),
  answerLength: z.enum(['brief', 'normal', 'detailed']).default('normal'),
  speculative: z.boolean().default(true),
  // On by default: an answer the candidate cannot defend in a follow-up is
  // worse than a plainer one they own. Users with deep expertise can turn it
  // off for unconstrained answers.
  grounded: z.boolean().default(true),
  complexity: z.enum(['simple', 'balanced', 'advanced']).default('balanced'),
})

// `prefault` (not `default`) so an absent section is replaced by `{}` *before*
// parsing, letting each field's own default apply. zod 4's `.default()` expects
// a fully-formed value here instead.
export const appSettingsSchema = z.object({
  providers: providerSettings.prefault({}),
  ui: uiSettings.prefault({}),
  session: sessionSettings.prefault({}),
})

export const DEFAULT_SETTINGS: AppSettings = appSettingsSchema.parse({})

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

let cache: AppSettings | null = null

export function getSettings(): AppSettings {
  if (cache) return cache
  const path = settingsPath()
  if (!existsSync(path)) {
    cache = DEFAULT_SETTINGS
    return cache
  }
  try {
    // Strip a UTF-8 BOM: `JSON.parse` rejects it outright, and plenty of editors
    // (and PowerShell's `Set-Content -Encoding utf8`) add one silently, which
    // would otherwise reset every setting to its default with no visible cause.
    const raw = readFileSync(path, 'utf8').replace(/^﻿/, '')
    const parsed = appSettingsSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      log.warn('settings failed validation; falling back to defaults', parsed.error.issues)
      cache = DEFAULT_SETTINGS
    } else {
      cache = parsed.data
    }
  } catch (err) {
    log.warn('settings unreadable; using defaults', err)
    cache = DEFAULT_SETTINGS
  }
  return cache
}

/** Shallow-merges each top-level section, so partial updates are safe. */
export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const current = getSettings()
  const merged = appSettingsSchema.parse({
    providers: { ...current.providers, ...patch.providers },
    ui: { ...current.ui, ...patch.ui },
    session: { ...current.session, ...patch.session },
  })
  const path = settingsPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8')
  } catch (err) {
    log.error('could not persist settings', err)
  }
  cache = merged
  return merged
}
