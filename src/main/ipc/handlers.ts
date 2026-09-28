/**
 * IPC wiring. Every channel the preload bridge exposes is registered here and
 * nowhere else, so the renderer's reachable surface is exactly this file.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { createLogger } from '@main/core/logger'
import { INVOKE, PUSH, SEND } from '@shared/ipc'
import type { ShortcutAction, ToastPayload } from '@shared/ipc'
import { credentialStatus, setCredentials } from '@main/config/credentials'
import { getSettings, updateSettings } from '@main/config/settings'
import { loadProfile, saveProfile } from '@main/config/profile-store'
import { applyUiSettings, hideOverlay } from '@main/windows/overlay'
import { refreshMenu } from '@main/windows/tray'
import { InterviewSession, SUMMARY_MODELS } from '@main/interview/session'
import { parseResume } from '@main/interview/resume-parser'
import { getLlmProvider } from '@main/providers/factory'
import { toWallClock } from '@main/core/trace'
import {
  EMPTY_PROFILE,
  type AnswerNudge,
  type AppSettings,
  type CandidateProfile,
  type ListenState,
  type SessionConfig,
  type StreamId,
  type TurnTrace,
} from '@shared/types'

const log = createLogger('ipc')

/**
 * The working copy. Backed by the encrypted on-disk store (DPAPI), loaded once
 * at registration; every change writes through. Clearing the profile in the UI
 * empties it, which deletes the file.
 */
let profile: CandidateProfile = { ...EMPTY_PROFILE }
const traces: TurnTrace[] = []

export function registerIpc(getWindow: () => BrowserWindow | null): InterviewSession {
  const push = <T>(channel: string, payload: T): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  const session = new InterviewSession({
    transcript: (line) => push(PUSH.transcript, line),
    interim: (speaker, text) => push(PUSH.interim, { stream: speaker, text }),
    question: (question) => push(PUSH.question, question),
    answerDelta: (questionId, delta) => push(PUSH.answerDelta, { questionId, delta }),
    answerDone: (payload) => push(PUSH.answerDone, payload),
    answerCancelled: (payload) => push(PUSH.answerCancelled, payload),
    answerError: (payload) => push(PUSH.answerError, payload),
    listenState: (indicator) => push(PUSH.listenState, { indicator }),
    trace: (trace) => {
      traces.push(trace)
      push(PUSH.trace, trace)
    },
    streamStatus: (stream, status) => push(PUSH.streamStatus, { stream, status }),
    sessionState: (state, error) => push(PUSH.sessionState, { state, error }),
    toast: (payload) => push(PUSH.toast, payload),
  })

  // --- Hot path -------------------------------------------------------------
  // `on`, not `handle`: audio frames must never await a reply. At 80 ms frames
  // this is ~12 messages/second per stream carrying 2560 bytes each.
  ipcMain.on(SEND.audioFrame, (_event, payload: { stream: StreamId; frame: ArrayBuffer }) => {
    session.routeFrame(payload.stream, payload.frame)
  })

  // Push-to-listen control. `on`, not `handle`: a held button toggles this many
  // times and must feel instant; the engine pushes the resolved indicator back.
  ipcMain.on(SEND.setListen, (_event, payload: { state: ListenState }) => {
    session.setListen(payload.state)
  })

  // Input levels stay in the renderer: the meter is decoration, and round-
  // tripping it through main would put pure UI chrome on the audio path.
  ipcMain.on(
    SEND.captureState,
    (_event, payload: { stream: StreamId; state: string; error?: string }) => {
      // Logged here because capture runs in the renderer, where failures are
      // otherwise invisible to anyone reading the main log — which is exactly
      // how a blocked AudioWorklet once looked like a silent session abort.
      const detail = payload.error ? ` — ${payload.error}` : ''
      if (payload.state === 'denied' || payload.state === 'error' || payload.state === 'unavailable') {
        log.error(`capture ${payload.stream}: ${payload.state}${detail}`)
      } else {
        log.info(`capture ${payload.stream}: ${payload.state}${detail}`)
      }
      push(PUSH.streamStatus, {
        stream: payload.stream,
        status: { capture: payload.state, error: payload.error },
      })
    }
  )

  // --- Session --------------------------------------------------------------
  ipcMain.handle(INVOKE.sessionStart, async (_event, config: SessionConfig) => {
    session.setProfile(profile)
    return session.start(config)
  })

  ipcMain.handle(INVOKE.sessionStop, async () => {
    session.stop()
    return { ok: true }
  })

  ipcMain.handle(INVOKE.sessionState, async () => session.sessionState)

  ipcMain.handle(INVOKE.clearSession, async () => {
    session.clearMemory()
    traces.length = 0
    return { ok: true }
  })

  // --- Profile --------------------------------------------------------------
  profile = loadProfile()
  if (Object.values(profile).some((v) => String(v).trim())) {
    session.setProfile(profile)
  }

  ipcMain.handle(INVOKE.profileGet, async () => profile)

  ipcMain.handle(INVOKE.profileSet, async (_event, next: CandidateProfile) => {
    profile = { ...EMPTY_PROFILE, ...next }
    session.setProfile(profile)
    // Write-through: an emptied profile deletes the file (that is how Clear works).
    saveProfile(profile)
    log.info('profile set', {
      fields: Object.entries(profile)
        .filter(([, v]) => Boolean(v))
        .map(([k]) => k),
    })
    return { ok: true }
  })

  ipcMain.handle(INVOKE.profileAutofill, async (_event, payload: { resume: string }) => {
    const resume = payload?.resume?.trim()
    if (!resume) return { ok: false, error: 'Paste your resume text first.' }
    try {
      const settings = getSettings()
      const llm = getLlmProvider(settings.providers.llmProvider)
      llm.validate()
      const model = SUMMARY_MODELS[llm.name] ?? settings.providers.llmModel
      const fields = await parseResume(resume, llm, model)
      if (Object.keys(fields).length === 0) {
        return { ok: false, error: 'Could not extract anything usable from that text.' }
      }
      return { ok: true, fields }
    } catch (err) {
      log.warn('resume autofill failed', err)
      return { ok: false, error: (err as Error).message }
    }
  })

  // --- Settings -------------------------------------------------------------
  ipcMain.handle(INVOKE.settingsGet, async () => getSettings())

  ipcMain.handle(INVOKE.settingsSet, async (_event, patch: Partial<AppSettings>) => {
    const next = updateSettings(patch)
    if (patch.ui) applyUiSettings(next.ui)
    if (patch.session) session.updateConfig(next.session)
    return next
  })

  ipcMain.handle(INVOKE.overlayApply, async (_event, ui: Partial<AppSettings['ui']>) => {
    applyUiSettings(ui)
    return { ok: true }
  })

  ipcMain.handle(INVOKE.overlayHide, async () => {
    hideOverlay()
    refreshMenu()
    return { ok: true }
  })

  ipcMain.handle(INVOKE.overlayQuit, async () => {
    session.stop()
    app.quit()
  })

  // --- Credentials ----------------------------------------------------------
  ipcMain.handle(INVOKE.credentialsStatus, async () => credentialStatus())

  ipcMain.handle(INVOKE.credentialsSet, async (_event, updates: Record<string, string>) => {
    setCredentials(updates)
    return credentialStatus()
  })

  // --- Answers --------------------------------------------------------------
  ipcMain.handle(INVOKE.askManual, async (_event, payload: { text: string }) => {
    session.turnEngine?.askManual(payload.text)
    return { ok: Boolean(session.turnEngine) }
  })

  ipcMain.handle(
    INVOKE.answerRegenerate,
    async (_event, payload?: { nudge?: AnswerNudge }) => {
      session.turnEngine?.regenerate(payload?.nudge)
      return { ok: Boolean(session.turnEngine) }
    }
  )

  ipcMain.handle(INVOKE.answerCancel, async () => {
    session.turnEngine?.cancelActive('user')
    return { ok: true }
  })

  // --- Diagnostics ----------------------------------------------------------
  ipcMain.handle(INVOKE.tracesExport, async () => {
    if (traces.length === 0) return { path: null }
    const dir = join(app.getPath('userData'), 'traces')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // No transcripts, no question text — timings only.
    const path = join(dir, `latency-${Date.now()}.jsonl`)
    const lines = traces.map((t) =>
      JSON.stringify({
        ...t,
        questionId: undefined,
        speechEndWall: t.speechEnd !== undefined ? toWallClock(t.speechEnd) : undefined,
        answerLatencyMs:
          t.speechEnd !== undefined && t.firstToken !== undefined
            ? Math.round(t.firstToken - t.speechEnd)
            : null,
      })
    )
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
    log.info(`exported ${traces.length} traces`)
    return { path }
  })

  return session
}

export function pushShortcut(window: BrowserWindow | null, action: ShortcutAction): void {
  if (window && !window.isDestroyed()) window.webContents.send(PUSH.shortcut, { action })
}

export function pushToast(window: BrowserWindow | null, payload: ToastPayload): void {
  if (window && !window.isDestroyed()) window.webContents.send(PUSH.toast, payload)
}

/**
 * Wipes per-run state on quit. The in-memory profile goes with the process
 * anyway; the encrypted on-disk copy intentionally survives — the user opted
 * into persistence, and Clear in the UI is what deletes it.
 */
export function clearSensitiveState(): void {
  profile = { ...EMPTY_PROFILE }
  traces.length = 0
}
