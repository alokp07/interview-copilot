/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 * Kept dependency-free so it can be imported from any of the three contexts.
 */

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/**
 * Physical capture channels. Speaker attribution is *channel-based*, not
 * diarization-based: whatever comes out of the speakers is the interviewer,
 * whatever goes into the microphone is the candidate. This is both cheaper and
 * far more reliable than diarization, and it guarantees the candidate's own
 * voice can never trigger an answer.
 */
export type StreamId = 'system' | 'mic'

export type Speaker = 'interviewer' | 'candidate'

export const SPEAKER_OF: Record<StreamId, Speaker> = {
  system: 'interviewer',
  mic: 'candidate',
}

/** Wire format we send to every STT provider. */
export const AUDIO = {
  sampleRate: 16_000,
  channels: 1,
  /** Deepgram strongly recommends 80 ms chunks for Flux. */
  frameMs: 80,
  /** 16_000 * 0.08 = 1280 samples = 2560 bytes of linear16. */
  samplesPerFrame: 1280,
  bytesPerFrame: 2560,
} as const

export type CaptureState =
  | 'idle'
  | 'requesting'
  | 'live'
  | 'denied'
  | 'unavailable'
  | 'error'

export interface StreamStatus {
  capture: CaptureState
  /** STT transport state for this channel. */
  transport: TransportState
  /** Human-readable last error, already redacted. */
  error?: string
  /** Rolling RMS level 0..1, for the UI meter. */
  level: number
}

export type TransportState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'closed'
  | 'error'

// ---------------------------------------------------------------------------
// Transcription / turns
// ---------------------------------------------------------------------------

/**
 * Normalized turn lifecycle, modelled on Deepgram Flux's state machine because
 * it is the richest of the providers we support. Providers without native turn
 * detection synthesize these events (see `contracts/stt.ts`).
 */
export type TurnPhase =
  | 'start'
  /** Interim text; the speaker is still talking. */
  | 'update'
  /** Provider is *moderately* confident the turn ended — speculate now. */
  | 'eager-end'
  /** The speaker kept going after an eager-end; abandon the speculation. */
  | 'resumed'
  /** Provider is confident the turn ended. */
  | 'end'

export interface TurnEvent {
  stream: StreamId
  phase: TurnPhase
  /** Provider's turn counter, monotonic per connection. */
  turnIndex: number
  transcript: string
  /** 0..1 — provider's confidence that the turn has ended. */
  endOfTurnConfidence: number
  /** Monotonic ms (`performance.now()` domain in main) when we observed it. */
  observedAt: number
  /** Seconds into the audio stream, from the provider. */
  audioWindowEnd: number
}

export interface TranscriptLine {
  id: string
  speaker: Speaker
  text: string
  final: boolean
  at: number
}

// ---------------------------------------------------------------------------
// Questions & answers
// ---------------------------------------------------------------------------

export type QuestionConfidence = 'high' | 'medium' | 'low'

export interface DetectedQuestion {
  id: string
  text: string
  confidence: QuestionConfidence
  /** Which classifier signal fired, for debugging the gate. */
  reason: string
  /** True while this came from an eager (speculative) end-of-turn. */
  speculative: boolean
  at: number
}

export type AnswerState =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'complete'
  | 'cancelled'
  | 'error'

export interface AnswerChunk {
  questionId: string
  delta: string
}

export interface AnswerDone {
  questionId: string
  text: string
  trace: TurnTrace
}

export interface AnswerCancelled {
  questionId: string
  reason: 'superseded' | 'turn-resumed' | 'user' | 'session-stopped'
}

export interface AnswerError {
  questionId: string
  message: string
  retryable: boolean
}

// ---------------------------------------------------------------------------
// Latency instrumentation
// ---------------------------------------------------------------------------

/**
 * Every mark is monotonic ms from a single clock. The headline number the
 * product is judged on is `firstToken - speechEnd`.
 */
export interface TurnTrace {
  questionId: string
  /** Provider said the turn started. */
  speechStart?: number
  /** Eager (speculative) end-of-turn. */
  eagerEnd?: number
  /** Confident end-of-turn — "the interviewer finished speaking". */
  speechEnd?: number
  /** Question gate finished deciding. */
  gated?: number
  /** LLM request written to the socket. */
  llmRequest?: number
  /** First answer token received. */
  firstToken?: number
  /** Generation finished. */
  complete?: number
  /** True if the speculative generation survived to become the real answer. */
  speculationHit?: boolean
  model?: string
  promptTokens?: number
  completionTokens?: number
}

export interface LatencySummary {
  /** speechEnd → firstToken. The number that matters. Negative = we beat them. */
  answerLatencyMs: number | null
  ttftMs: number | null
  totalMs: number | null
  speculationHit: boolean
}

// ---------------------------------------------------------------------------
// Interview session / profile
// ---------------------------------------------------------------------------

export type InterviewMode =
  | 'general'
  | 'technical'
  | 'behavioral'
  | 'system-design'
  | 'coding'
  | 'hr'

export interface CandidateProfile {
  name: string
  role: string
  yearsExperience: string
  skills: string
  projects: string
  resume: string
  jobDescription: string
  company: string
  notes: string
}

export const EMPTY_PROFILE: CandidateProfile = {
  name: '',
  role: '',
  yearsExperience: '',
  skills: '',
  projects: '',
  resume: '',
  jobDescription: '',
  company: '',
  notes: '',
}

export interface SessionConfig {
  mode: InterviewMode
  /** Answer verbosity target, in words. */
  answerLength: 'brief' | 'normal' | 'detailed'
  /** Fire generation on eager end-of-turn instead of waiting for confirmation. */
  speculative: boolean
}

export type SessionState = 'stopped' | 'starting' | 'running' | 'stopping'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface ProviderSettings {
  sttProvider: string
  llmProvider: string
  llmModel: string
  /** 0.3–0.9. Lower fires sooner, with more false starts. */
  eagerEotThreshold: number
  /** 0.5–0.9. */
  eotThreshold: number
  eotTimeoutMs: number
}

export interface UiSettings {
  alwaysOnTop: boolean
  /** Hides the window from screen-capture at the compositor level (Windows). */
  contentProtection: boolean
  opacity: number
  showTranscript: boolean
  showLatency: boolean
}

export interface AppSettings {
  providers: ProviderSettings
  ui: UiSettings
  session: SessionConfig
}

/** Which credentials are present — never the values themselves. */
export interface CredentialStatus {
  deepgram: boolean
  groq: boolean
  openrouter: boolean
  openai: boolean
  anthropic: boolean
}
