/**
 * Speech-to-text plugin contract.
 *
 * A session is one live connection carrying one audio channel. The contract is
 * deliberately turn-shaped rather than word-shaped: the pipeline needs to know
 * *when a turn ended* far more than it needs raw words, and turn boundaries are
 * where the latency is won or lost.
 *
 * Providers with native turn detection (Deepgram Flux) map their events
 * directly. Providers without it (Nova-3, AssemblyAI, Whisper) declare
 * `nativeTurnDetection: false` and synthesize turn events from interim results
 * plus a silence timer — see `SyntheticTurnDetector`.
 */

import type { StreamId, TurnEvent } from '@shared/types'

export interface STTCapabilities {
  streaming: boolean
  /** Provider emits its own end-of-turn signal. */
  nativeTurnDetection: boolean
  /** Provider emits a speculative end-of-turn ahead of the confirmed one. */
  eagerEndOfTurn: boolean
  sampleRate: number
  /** Words that should be biased toward, e.g. domain jargon from the JD. */
  supportsKeyterms: boolean
}

export interface STTSessionOptions {
  stream: StreamId
  /** Bias the recognizer toward these terms (job title, stack, product names). */
  keyterms?: string[]
  eagerEotThreshold?: number
  eotThreshold?: number
  eotTimeoutMs?: number
}

export interface STTSessionCallbacks {
  onTurn: (event: TurnEvent) => void
  onStateChange: (
    state: 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error',
    detail?: string
  ) => void
}

export interface STTSession {
  readonly stream: StreamId
  /** Push one linear16 mono frame at the negotiated sample rate. */
  send(frame: ArrayBuffer | Buffer): void
  /** Open the socket. Safe to call before audio exists — that is the point. */
  connect(): Promise<void>
  close(): void
  readonly connected: boolean
}

export interface STTProvider {
  readonly name: string
  readonly capabilities: STTCapabilities
  /** Throws with an actionable message when credentials are missing. */
  validate(): void
  createSession(options: STTSessionOptions, callbacks: STTSessionCallbacks): STTSession
}
