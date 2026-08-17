/**
 * Development-only stand-in for the preload bridge.
 *
 * The overlay sets `contentProtection`, which excludes it from *all* screen
 * capture — so it cannot be screenshotted, which makes iterating on the design
 * genuinely awkward. Installing a fake `window.cue` lets the renderer run in an
 * ordinary browser tab at the Vite dev URL, with representative data, so layout
 * and typography can be worked on with fast feedback and no Electron restart.
 *
 * Never installed when the real bridge is present, and stripped from production
 * builds by the `import.meta.env.DEV` guard at the call site.
 */

import { EMPTY_PROFILE, type AppSettings, type CandidateProfile } from '@shared/types'

const DEMO_ANSWER =
  "I chose MongoDB because the data model was highly nested and changed constantly — " +
  'each story node had different fields depending on its type, so a document store let ' +
  'us iterate without migrations. The trade-off was giving up joins, which we handled by ' +
  'denormalising the few relational bits we actually needed.'

const DEMO_SETTINGS: AppSettings = {
  providers: {
    sttProvider: 'deepgram-flux',
    llmProvider: 'groq',
    llmModel: 'openai/gpt-oss-20b',
    eagerEotThreshold: 0.4,
    eotThreshold: 0.7,
    eotTimeoutMs: 4000,
  },
  ui: {
    alwaysOnTop: true,
    contentProtection: true,
    opacity: 1,
    showTranscript: true,
    showLatency: true,
  },
  session: { mode: 'general', answerLength: 'normal', speculative: true },
}

type Handler = (payload: unknown) => void

export function installDevBridge(): void {
  const listeners = new Map<string, Set<Handler>>()
  const emit = (channel: string, payload: unknown): void => {
    for (const handler of listeners.get(channel) ?? []) handler(payload)
  }

  const PUSH = {
    transcript: 'push:transcript',
    interim: 'push:interim',
    question: 'push:question',
    answerDelta: 'push:answer-delta',
    answerDone: 'push:answer-done',
    answerCancelled: 'push:answer-cancelled',
    answerError: 'push:answer-error',
    streamStatus: 'push:stream-status',
    sessionState: 'push:session-state',
    trace: 'push:trace',
    toast: 'push:toast',
    shortcut: 'push:shortcut',
  }

  let profile: CandidateProfile = {
    ...EMPTY_PROFILE,
    name: 'Alok',
    role: 'Senior Full-Stack Engineer',
    skills: 'React, Node.js, Python, MongoDB, AI systems',
  }
  let settings = DEMO_SETTINGS
  let timers: ReturnType<typeof setTimeout>[] = []

  const later = (ms: number, fn: () => void): void => {
    timers.push(setTimeout(fn, ms))
  }

  /** Replays a realistic question → streaming answer cycle. */
  function playDemo(): void {
    const questionId = `demo-${Date.now()}`
    emit(PUSH.streamStatus, { stream: 'system', status: { capture: 'live', transport: 'connected', level: 0.4 } })
    emit(PUSH.streamStatus, { stream: 'mic', status: { capture: 'live', transport: 'connected', level: 0.1 } })

    emit(PUSH.interim, { stream: 'system', text: 'so why did you choose' })
    later(300, () => emit(PUSH.interim, { stream: 'system', text: 'so why did you choose mongodb for' }))

    later(650, () => {
      emit(PUSH.interim, { stream: 'system', text: '' })
      emit(PUSH.transcript, {
        id: `t-${Date.now()}`,
        speaker: 'interviewer',
        text: 'So why did you choose MongoDB for that project instead of Postgres?',
        final: true,
        at: Date.now(),
      })
      emit(PUSH.question, {
        id: questionId,
        text: 'So why did you choose MongoDB for that project instead of Postgres?',
        confidence: 'high',
        reason: 'wh-initial+question-mark',
        speculative: true,
        at: Date.now(),
      })
    })

    // Stream the answer in word-sized chunks, as the real pipeline does.
    const words = DEMO_ANSWER.split(' ')
    words.forEach((word, i) => {
      later(820 + i * 22, () => emit(PUSH.answerDelta, { questionId, delta: `${word} ` }))
    })

    later(1100, () =>
      emit(PUSH.question, {
        id: questionId,
        text: 'So why did you choose MongoDB for that project instead of Postgres?',
        confidence: 'high',
        reason: 'promoted-speculation',
        speculative: false,
        at: Date.now(),
      })
    )

    later(860 + words.length * 22, () => {
      emit(PUSH.answerDone, {
        questionId,
        text: DEMO_ANSWER,
        trace: { questionId, speechEnd: 1000, firstToken: 1290, complete: 1800, speculationHit: true },
      })
      emit(PUSH.trace, {
        questionId,
        speechEnd: 1000,
        firstToken: 1290,
        complete: 1800,
        speculationHit: true,
      })
    })
  }

  const api = {
    sendAudioFrame: () => {},
    sendCaptureState: () => {},

    startSession: async () => {
      emit(PUSH.sessionState, { state: 'starting' })
      later(400, () => {
        emit(PUSH.sessionState, { state: 'running' })
        playDemo()
      })
      return { ok: true }
    },
    stopSession: async () => {
      timers.forEach(clearTimeout)
      timers = []
      emit(PUSH.sessionState, { state: 'stopped' })
      emit(PUSH.streamStatus, { stream: 'system', status: { capture: 'idle', transport: 'idle', level: 0 } })
      emit(PUSH.streamStatus, { stream: 'mic', status: { capture: 'idle', transport: 'idle', level: 0 } })
      return { ok: true }
    },
    getSessionState: async () => 'stopped' as const,
    clearSession: async () => ({ ok: true }),

    getProfile: async () => profile,
    setProfile: async (next: CandidateProfile) => {
      profile = next
      return { ok: true }
    },

    getSettings: async () => settings,
    setSettings: async (patch: Partial<AppSettings>) => {
      settings = {
        providers: { ...settings.providers, ...patch.providers },
        ui: { ...settings.ui, ...patch.ui },
        session: { ...settings.session, ...patch.session },
      }
      return settings
    },
    applyOverlay: async () => ({ ok: true }),
    hideOverlay: async () => ({ ok: true }),
    quit: async () => {},

    getCredentialStatus: async () => ({
      deepgram: true,
      groq: true,
      openrouter: true,
      openai: false,
      anthropic: false,
    }),
    setCredentials: async () => ({
      deepgram: true,
      groq: true,
      openrouter: true,
      openai: false,
      anthropic: false,
    }),

    askManual: async () => {
      playDemo()
      return { ok: true }
    },
    regenerate: async () => {
      playDemo()
      return { ok: true }
    },
    cancelAnswer: async () => ({ ok: true }),
    exportTraces: async () => ({ path: 'C:\\demo\\latency.jsonl' }),

    on(channel: string, handler: Handler) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(handler)
      return () => listeners.get(channel)?.delete(handler)
    },

    channels: { PUSH, INVOKE: {}, SEND: {} },
    platform: 'win32',
  }

  ;(window as unknown as { cue: unknown }).cue = api

  const params = new URLSearchParams(window.location.search)

  // `?view=profile` jumps straight to a tab, so any screen can be inspected
  // without clicking through the UI first.
  const view = params.get('view')
  if (view === 'profile' || view === 'settings' || view === 'live') {
    void import('../state/store').then(({ useStore }) => useStore.getState().setView(view))
  }

  // `?demo=1` starts a session and replays a question immediately.
  if (params.has('demo')) {
    setTimeout(() => {
      emit(PUSH.sessionState, { state: 'running' })
      playDemo()
    }, 250)
  }

  // eslint-disable-next-line no-console
  console.info('[cue] dev bridge installed — running without Electron, data is fake')
}
