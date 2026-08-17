/**
 * The complete, typed IPC surface. Channel names live here so main, preload and
 * renderer can never drift apart, and so the preload bridge can whitelist
 * exactly these and nothing else.
 */

import type {
  AnswerCancelled,
  AnswerChunk,
  AnswerDone,
  AnswerError,
  AppSettings,
  CandidateProfile,
  CredentialStatus,
  DetectedQuestion,
  SessionConfig,
  SessionState,
  StreamId,
  StreamStatus,
  TranscriptLine,
  TurnTrace,
} from './types'

/** Renderer → main, fire-and-forget (no reply, no await). */
export const SEND = {
  /** Hot path: one 2560-byte linear16 frame every 80 ms, per stream. */
  audioFrame: 'audio:frame',
  captureState: 'audio:capture-state',
} as const

/** Renderer → main, request/response. */
export const INVOKE = {
  sessionStart: 'session:start',
  sessionStop: 'session:stop',
  sessionState: 'session:state',

  profileGet: 'profile:get',
  profileSet: 'profile:set',

  settingsGet: 'settings:get',
  settingsSet: 'settings:set',

  credentialsStatus: 'credentials:status',
  credentialsSet: 'credentials:set',

  askManual: 'answer:ask-manual',
  answerRegenerate: 'answer:regenerate',
  answerCancel: 'answer:cancel',

  overlayApply: 'overlay:apply',
  overlayHide: 'overlay:hide',
  overlayQuit: 'overlay:quit',

  tracesExport: 'traces:export',
  clearSession: 'session:clear',
} as const

/** Main → renderer, push. */
export const PUSH = {
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
} as const

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface AudioFramePayload {
  stream: StreamId
  /** linear16 mono @16 kHz, exactly AUDIO.bytesPerFrame long. */
  frame: ArrayBuffer
}

export interface InterimPayload {
  stream: StreamId
  text: string
}

export interface ToastPayload {
  level: 'info' | 'warn' | 'error'
  message: string
}

export type ShortcutAction =
  | 'toggle-visibility'
  | 'toggle-listening'
  | 'regenerate'
  | 'clear'
  | 'cycle-opacity'

/** Everything main can push, keyed by channel, for a typed `on()` in preload. */
export interface PushMap {
  [PUSH.transcript]: TranscriptLine
  [PUSH.interim]: InterimPayload
  [PUSH.question]: DetectedQuestion
  [PUSH.answerDelta]: AnswerChunk
  [PUSH.answerDone]: AnswerDone
  [PUSH.answerCancelled]: AnswerCancelled
  [PUSH.answerError]: AnswerError
  [PUSH.streamStatus]: { stream: StreamId; status: Partial<StreamStatus> }
  [PUSH.sessionState]: { state: SessionState; error?: string }
  [PUSH.trace]: TurnTrace
  [PUSH.toast]: ToastPayload
  [PUSH.shortcut]: { action: ShortcutAction }
}

/** Everything main can answer, keyed by channel. */
export interface InvokeMap {
  [INVOKE.sessionStart]: { req: SessionConfig; res: { ok: boolean; error?: string } }
  [INVOKE.sessionStop]: { req: void; res: { ok: boolean } }
  [INVOKE.sessionState]: { req: void; res: SessionState }
  [INVOKE.profileGet]: { req: void; res: CandidateProfile }
  [INVOKE.profileSet]: { req: CandidateProfile; res: { ok: boolean } }
  [INVOKE.settingsGet]: { req: void; res: AppSettings }
  [INVOKE.settingsSet]: { req: Partial<AppSettings>; res: AppSettings }
  [INVOKE.credentialsStatus]: { req: void; res: CredentialStatus }
  [INVOKE.credentialsSet]: { req: Record<string, string>; res: CredentialStatus }
  [INVOKE.askManual]: { req: { text: string }; res: { ok: boolean } }
  [INVOKE.answerRegenerate]: { req: void; res: { ok: boolean } }
  [INVOKE.answerCancel]: { req: void; res: { ok: boolean } }
  [INVOKE.overlayApply]: { req: Partial<AppSettings['ui']>; res: { ok: boolean } }
  [INVOKE.overlayHide]: { req: void; res: { ok: boolean } }
  [INVOKE.overlayQuit]: { req: void; res: void }
  [INVOKE.tracesExport]: { req: void; res: { path: string | null } }
  [INVOKE.clearSession]: { req: void; res: { ok: boolean } }
}
