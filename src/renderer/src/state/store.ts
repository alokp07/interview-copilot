/**
 * Renderer state. One flat store, because the UI is small and the update rate
 * is high — the answer stream in particular touches this many times a second,
 * so cheap updates matter more than elegant normalization.
 */

import { create } from 'zustand'
import {
  EMPTY_PROFILE,
  type AnswerState,
  type AppSettings,
  type CandidateProfile,
  type CredentialStatus,
  type DetectedQuestion,
  type ListenIndicator,
  type SessionState,
  type StreamId,
  type StreamStatus,
  type TranscriptLine,
  type TurnTrace,
} from '@shared/types'

export type View = 'live' | 'profile' | 'settings'

export interface AnswerView {
  questionId: string | null
  text: string
  state: AnswerState
  /** Generated from an eager end-of-turn, not yet confirmed. */
  speculative: boolean
  error: string | null
}

const emptyStreamStatus = (): StreamStatus => ({
  capture: 'idle',
  transport: 'idle',
  level: 0,
})

interface Store {
  view: View
  sessionState: SessionState
  sessionError: string | null
  /** Resolved push-to-listen indicator from the engine (off/armed/listening/always). */
  listen: ListenIndicator

  streams: Record<StreamId, StreamStatus>
  interim: Record<'interviewer' | 'candidate', string>
  transcript: TranscriptLine[]

  question: DetectedQuestion | null
  answer: AnswerView
  traces: TurnTrace[]

  settings: AppSettings | null
  profile: CandidateProfile
  credentials: CredentialStatus | null

  toast: { level: 'info' | 'warn' | 'error'; message: string; at: number } | null

  setView: (view: View) => void
  setSessionState: (state: SessionState, error?: string) => void
  setListen: (indicator: ListenIndicator) => void
  patchStream: (stream: StreamId, patch: Partial<StreamStatus>) => void
  setInterim: (who: 'interviewer' | 'candidate', text: string) => void
  addTranscript: (line: TranscriptLine) => void
  setQuestion: (question: DetectedQuestion) => void
  appendAnswer: (questionId: string, delta: string) => void
  completeAnswer: (questionId: string, trace: TurnTrace) => void
  cancelAnswer: (questionId: string) => void
  failAnswer: (questionId: string, message: string) => void
  setSettings: (settings: AppSettings) => void
  setProfile: (profile: CandidateProfile) => void
  setCredentials: (credentials: CredentialStatus) => void
  showToast: (level: 'info' | 'warn' | 'error', message: string) => void
  clearAll: () => void
}

const IDLE_ANSWER: AnswerView = {
  questionId: null,
  text: '',
  state: 'idle',
  speculative: false,
  error: null,
}

/** Bounded so a long interview cannot grow the renderer's memory without limit. */
const MAX_TRANSCRIPT = 200
const MAX_TRACES = 100

export const useStore = create<Store>((set) => ({
  view: 'live',
  sessionState: 'stopped',
  sessionError: null,
  listen: 'off',

  streams: { system: emptyStreamStatus(), mic: emptyStreamStatus() },
  interim: { interviewer: '', candidate: '' },
  transcript: [],

  question: null,
  answer: IDLE_ANSWER,
  traces: [],

  settings: null,
  profile: { ...EMPTY_PROFILE },
  credentials: null,
  toast: null,

  setView: (view) => set({ view }),

  setSessionState: (sessionState, error) =>
    // A stopped session is listening to nothing; clear the indicator so the UI
    // never shows a stale "armed"/"always" after Stop.
    set({
      sessionState,
      sessionError: error ?? null,
      ...(sessionState === 'stopped' ? { listen: 'off' as ListenIndicator } : {}),
    }),

  setListen: (listen) => set({ listen }),

  patchStream: (stream, patch) =>
    set((s) => ({ streams: { ...s.streams, [stream]: { ...s.streams[stream], ...patch } } })),

  setInterim: (who, text) => set((s) => ({ interim: { ...s.interim, [who]: text } })),

  addTranscript: (line) =>
    set((s) => ({ transcript: [...s.transcript, line].slice(-MAX_TRANSCRIPT) })),

  setQuestion: (question) =>
    set((s) => {
      // A promoted speculation keeps the answer already on screen and simply
      // drops the "speculative" styling — never a flash of empty state.
      const sameAnswer = s.answer.questionId === question.id
      return {
        question,
        answer: sameAnswer
          ? { ...s.answer, speculative: question.speculative }
          : {
              questionId: question.id,
              text: '',
              state: 'thinking' as AnswerState,
              speculative: question.speculative,
              error: null,
            },
      }
    }),

  appendAnswer: (questionId, delta) =>
    set((s) => {
      if (s.answer.questionId !== questionId) return s
      return {
        answer: { ...s.answer, text: s.answer.text + delta, state: 'streaming' },
      }
    }),

  completeAnswer: (questionId, trace) =>
    set((s) => ({
      traces: [...s.traces, trace].slice(-MAX_TRACES),
      answer:
        s.answer.questionId === questionId
          ? { ...s.answer, state: 'complete', speculative: false }
          : s.answer,
    })),

  cancelAnswer: (questionId) =>
    set((s) => (s.answer.questionId === questionId ? { answer: IDLE_ANSWER } : s)),

  failAnswer: (questionId, message) =>
    set((s) =>
      s.answer.questionId === questionId
        ? { answer: { ...s.answer, state: 'error', error: message } }
        : s
    ),

  setSettings: (settings) => set({ settings }),
  setProfile: (profile) => set({ profile }),
  setCredentials: (credentials) => set({ credentials }),

  showToast: (level, message) => set({ toast: { level, message, at: Date.now() } }),

  clearAll: () =>
    set({
      transcript: [],
      interim: { interviewer: '', candidate: '' },
      question: null,
      answer: IDLE_ANSWER,
      traces: [],
    }),
}))

/** Rolling latency figures for the status bar. */
export function summarizeTraces(traces: TurnTrace[]): {
  last: number | null
  median: number | null
  hitRate: number | null
} {
  const latencies = traces
    .map((t) =>
      t.speechEnd !== undefined && t.firstToken !== undefined ? t.firstToken - t.speechEnd : null
    )
    .filter((v): v is number => v !== null)

  if (latencies.length === 0) return { last: null, median: null, hitRate: null }
  const sorted = [...latencies].sort((a, b) => a - b)
  const hits = traces.filter((t) => t.speculationHit).length
  return {
    last: latencies[latencies.length - 1] ?? null,
    median: sorted[Math.floor(sorted.length / 2)] ?? null,
    hitRate: traces.length > 0 ? hits / traces.length : null,
  }
}
