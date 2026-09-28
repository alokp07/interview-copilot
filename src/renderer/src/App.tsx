import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AudioCapture } from './audio/capture'
import { StatusBar, TitleBar } from './components/Chrome'
import { AnswerPanel, QuestionPanel, TranscriptPanel } from './components/LivePanels'
import { ListenControl } from './components/ListenControl'
import { ProfileView } from './components/ProfileView'
import { SettingsView } from './components/SettingsView'
import { Button } from './components/primitives'
import { applyTheme } from './lib/theme'
import { useStore } from './state/store'
import type { ListenMode, SessionConfig } from '@shared/types'

export function App(): ReactNode {
  const store = useStore()
  const {
    view,
    sessionState,
    listen,
    settings,
    question,
    answer,
    transcript,
    interim,
    toast,
  } = store

  const [manualQuestion, setManualQuestion] = useState('')
  // Collapsed by default: the transcript is reference material, and every pixel
  // it takes comes out of the answer.
  const [transcriptExpanded, setTranscriptExpanded] = useState(false)

  // One capture instance for the app's lifetime. It owns the AudioContext, so
  // recreating it per render would tear down live audio.
  const capture = useMemo(
    () =>
      new AudioCapture(
        (stream, frame) => window.cue.sendAudioFrame(stream, frame),
        (stream, state, error) => {
          useStore.getState().patchStream(stream, { capture: state, error })
          window.cue.sendCaptureState(stream, state, error)
        },
        (stream, level) => useStore.getState().patchStream(stream, { level })
      ),
    []
  )

  const captureRef = useRef(capture)
  captureRef.current = capture

  // --- main → renderer events ----------------------------------------------
  useEffect(() => {
    const s = useStore.getState()
    const { PUSH } = window.cue.channels
    const off = [
      window.cue.on(PUSH.transcript, (line) => s.addTranscript(line)),
      window.cue.on(PUSH.interim, (p) =>
        s.setInterim(p.stream === 'system' ? 'interviewer' : 'candidate', p.text)
      ),
      window.cue.on(PUSH.question, (q) => s.setQuestion(q)),
      window.cue.on(PUSH.answerDelta, (p) => s.appendAnswer(p.questionId, p.delta)),
      window.cue.on(PUSH.answerDone, (p) => s.completeAnswer(p.questionId, p.trace)),
      window.cue.on(PUSH.answerCancelled, (p) => s.cancelAnswer(p.questionId)),
      window.cue.on(PUSH.answerError, (p) => s.failAnswer(p.questionId, p.message)),
      window.cue.on(PUSH.streamStatus, (p) => s.patchStream(p.stream, p.status)),
      window.cue.on(PUSH.sessionState, (p) => s.setSessionState(p.state, p.error)),
      window.cue.on(PUSH.listenState, (p) => s.setListen(p.indicator)),
      window.cue.on(PUSH.toast, (p) => s.showToast(p.level, p.message)),
    ]
    return () => off.forEach((fn) => fn())
  }, [])

  // --- initial load ---------------------------------------------------------
  useEffect(() => {
    const s = useStore.getState()
    void window.cue.getSettings().then(s.setSettings)
    void window.cue.getProfile().then(s.setProfile)
    void window.cue.getCredentialStatus().then(s.setCredentials)
  }, [])

  // --- session control ------------------------------------------------------
  const stopSession = useCallback(async (): Promise<void> => {
    captureRef.current.stopAll()
    await window.cue.stopSession()
  }, [])

  const startSession = useCallback(async (): Promise<void> => {
    const s = useStore.getState()
    const config: SessionConfig = s.settings?.session ?? {
      mode: 'general',
      answerLength: 'normal',
      speculative: true,
      grounded: true,
      complexity: 'balanced',
      listenMode: 'manual',
      providerFallback: true,
    }

    // Audio first, and deliberately so: `getDisplayMedia` requires transient
    // user activation from the click, and the provider handshake takes a couple
    // of seconds — long enough to outlive it. Frames produced before the
    // session exists are simply dropped by the router, so starting early is
    // free.
    const system = await captureRef.current.startSystem()
    const mic = await captureRef.current.startMic()

    if (!system && !mic) {
      const reason =
        useStore.getState().streams.system.error ??
        useStore.getState().streams.mic.error ??
        'Check Windows privacy settings for microphone and screen recording.'
      s.showToast('error', `No audio could be captured. ${reason}`)
      captureRef.current.stopAll()
      return
    }

    const result = await window.cue.startSession(config)
    if (!result.ok) {
      captureRef.current.stopAll()
      s.showToast('error', result.error ?? 'Could not start the session.')
      return
    }

    if (!system) {
      s.showToast(
        'warn',
        'System audio is unavailable, so the interviewer will not be heard. Only your microphone is live.'
      )
    } else if (!mic) {
      s.showToast('warn', 'Microphone unavailable — running on system audio only.')
    }
  }, [])

  const toggleSession = useCallback((): void => {
    const state = useStore.getState().sessionState
    if (state === 'running') void stopSession()
    else if (state === 'stopped') void startSession()
  }, [startSession, stopSession])

  // These only work with a live engine; give feedback instead of silently no-op'ing.
  const requireSession = useCallback((result: Promise<{ ok: boolean }>): void => {
    void result.then((r) => {
      if (!r.ok) useStore.getState().showToast('warn', 'Press Start first — there is no live session yet.')
    })
  }, [])

  // --- global shortcuts (delivered from main) -------------------------------
  useEffect(() => {
    const { PUSH } = window.cue.channels
    return window.cue.on(PUSH.shortcut, ({ action }) => {
      if (action === 'toggle-listening') toggleSession()
      else if (action === 'arm-listen') {
        // Only meaningful mid-session and in manual mode; harmless otherwise.
        if (useStore.getState().sessionState === 'running') window.cue.setListen('armed')
      } else if (action === 'regenerate') requireSession(window.cue.regenerate())
      else if (action === 'clear') {
        useStore.getState().clearAll()
        void window.cue.clearSession()
      }
    })
  }, [toggleSession, requireSession])

  // Tear the audio graph down on unload so device handles are always released.
  useEffect(() => {
    const onUnload = (): void => captureRef.current.stopAll()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [])

  // --- theme ----------------------------------------------------------------
  // Re-apply whenever the authoritative UI settings change (initial load, or a
  // change made in Settings).
  useEffect(() => {
    if (settings) applyTheme(settings.ui.theme, settings.ui.accent)
  }, [settings?.ui.theme, settings?.ui.accent])

  // --- toast auto-dismiss ---------------------------------------------------
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => useStore.setState({ toast: null }), 6000)
    return () => clearTimeout(id)
  }, [toast])

  const submitManual = (): void => {
    const text = manualQuestion.trim()
    if (!text) return
    requireSession(window.cue.askManual(text))
    setManualQuestion('')
  }

  const changeListenMode = useCallback((mode: ListenMode): void => {
    const current = useStore.getState().settings
    if (!current) return
    const session = { ...current.session, listenMode: mode }
    // Optimistic local update, then persist; the engine picks it up live.
    useStore.getState().setSettings({ ...current, session })
    void window.cue.setSettings({ session }).then((next) => {
      useStore.getState().setSettings(next)
    })
  }, [])

  return (
    <div className="flex h-full flex-col bg-base">
      <TitleBar onToggleSession={toggleSession} sessionState={sessionState} />

      {toast ? (
        <div
          className={`fade-in shrink-0 px-3 py-1.5 text-[11px] leading-snug ${
            toast.level === 'error'
              ? 'bg-danger/12 text-danger'
              : toast.level === 'warn'
                ? 'bg-warn/12 text-warn'
                : 'bg-accent/12 text-accent-soft'
          }`}
        >
          {toast.message}
        </div>
      ) : null}

      {view === 'live' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-2.5 py-2.5">
          {sessionState === 'running' && settings ? (
            <ListenControl
              listenMode={settings.session.listenMode}
              indicator={listen}
              onChangeMode={changeListenMode}
            />
          ) : null}

          <QuestionPanel question={question} />

          <AnswerPanel
            answer={answer}
            sessionState={sessionState}
            onRegenerate={() => requireSession(window.cue.regenerate())}
            onNudge={(nudge) => requireSession(window.cue.regenerate(nudge))}
          />

          {settings?.ui.showTranscript ? (
            <TranscriptPanel
              lines={transcript}
              interimInterviewer={interim.interviewer}
              interimCandidate={interim.candidate}
              expanded={transcriptExpanded}
              onToggle={() => setTranscriptExpanded((v) => !v)}
            />
          ) : null}

          <div className="flex shrink-0 items-center gap-1.5">
            <input
              value={manualQuestion}
              onChange={(e) => setManualQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitManual()
              }}
              placeholder="Ask something directly…"
              className="field no-drag selectable flex-1"
            />
            <Button onClick={submitManual} disabled={!manualQuestion.trim()} tone="ghost">
              Ask
            </Button>
          </div>
        </div>
      ) : null}

      {view === 'profile' ? <ProfileView /> : null}
      {view === 'settings' ? <SettingsView /> : null}

      <StatusBar showLatency={settings?.ui.showLatency ?? true} />
    </div>
  )
}
