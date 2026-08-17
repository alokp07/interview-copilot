/**
 * Deepgram Flux (`wss://api.deepgram.com/v2/listen`).
 *
 * Flux is a turn-based conversational model rather than a plain transcriber, and
 * that is precisely why it is the default: it emits `EagerEndOfTurn` when it is
 * *moderately* confident the speaker has finished, 150–250 ms before the
 * confirmed `EndOfTurn`, and `TurnResumed` if they carry on. That gives us a
 * documented, model-driven speculation signal instead of a hand-rolled pile of
 * silence timers and punctuation heuristics — which is the single biggest
 * latency lever in the product.
 *
 * Event flow:
 *   StartOfTurn → Update* → [EagerEndOfTurn → (TurnResumed → Update*)?] → EndOfTurn
 */

import { createLogger } from '@main/core/logger'
import { now } from '@main/core/trace'
import { getCredential } from '@main/config/credentials'
import type {
  STTProvider,
  STTSession,
  STTSessionCallbacks,
  STTSessionOptions,
  STTCapabilities,
} from '@main/contracts/stt'
import { AUDIO, type TurnPhase } from '@shared/types'

const log = createLogger('stt:deepgram-flux')

const ENDPOINT = 'wss://api.deepgram.com/v2/listen'
const MODEL = 'flux-general-en'

/** Reconnect backoff — fast at first, because a dropped socket means deafness. */
const BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000]

interface FluxTurnInfo {
  type: 'TurnInfo'
  event: 'StartOfTurn' | 'Update' | 'EagerEndOfTurn' | 'TurnResumed' | 'EndOfTurn'
  turn_index: number
  transcript: string
  end_of_turn_confidence: number
  audio_window_start: number
  audio_window_end: number
  request_id: string
}

interface FluxConnected {
  type: 'Connected'
  request_id: string
}

interface FluxError {
  type: 'Error'
  code?: string
  description?: string
}

type FluxMessage = FluxTurnInfo | FluxConnected | FluxError | { type: string }

const PHASE_OF: Record<FluxTurnInfo['event'], TurnPhase> = {
  StartOfTurn: 'start',
  Update: 'update',
  EagerEndOfTurn: 'eager-end',
  TurnResumed: 'resumed',
  EndOfTurn: 'end',
}

class FluxSession implements STTSession {
  readonly stream: STTSessionOptions['stream']

  private ws: WebSocket | null = null
  private closedByUs = false
  private attempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  /**
   * Frames that arrived while the socket was down. Bounded to ~2 s: an interview
   * question older than that is no longer worth answering, and an unbounded
   * queue would turn a network blip into a memory leak.
   */
  private pending: ArrayBuffer[] = []
  private static readonly MAX_PENDING = Math.ceil(2000 / AUDIO.frameMs)

  constructor(
    private readonly apiKey: string,
    private readonly options: STTSessionOptions,
    private readonly callbacks: STTSessionCallbacks
  ) {
    this.stream = options.stream
  }

  get connected(): boolean {
    return this.ws?.readyState === 1
  }

  private buildUrl(): string {
    const url = new URL(ENDPOINT)
    const p = url.searchParams
    p.set('model', MODEL)
    p.set('encoding', 'linear16')
    p.set('sample_rate', String(AUDIO.sampleRate))
    p.set('eot_threshold', String(this.options.eotThreshold ?? 0.7))
    p.set('eot_timeout_ms', String(this.options.eotTimeoutMs ?? 4000))
    // Only set when speculation is enabled: passing it is what turns on
    // EagerEndOfTurn / TurnResumed at all.
    if (this.options.eagerEotThreshold !== undefined) {
      p.set('eager_eot_threshold', String(this.options.eagerEotThreshold))
    }
    for (const term of this.options.keyterms ?? []) {
      if (term.trim()) p.append('keyterm', term.trim())
    }
    return url.toString()
  }

  async connect(): Promise<void> {
    this.closedByUs = false
    this.callbacks.onStateChange(this.attempt === 0 ? 'connecting' : 'reconnecting')

    const url = this.buildUrl()
    let ws: WebSocket
    try {
      // Node/Electron's WebSocket accepts an options bag with headers — the
      // browser API does not, but this only ever runs in the main process, which
      // is also the only place the API key is allowed to exist.
      ws = new WebSocket(url, {
        headers: { Authorization: `Token ${this.apiKey}` },
      } as unknown as string[])
    } catch (err) {
      this.fail(`could not open socket: ${(err as Error).message}`)
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.addEventListener('open', () => {
      this.attempt = 0
      log.info(`${this.stream}: connected`)
      this.callbacks.onStateChange('connected')
      // Drain whatever piled up while we were down.
      const queued = this.pending
      this.pending = []
      for (const frame of queued) this.rawSend(frame)
    })

    ws.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data !== 'string') return
      this.handleMessage(event.data)
    })

    ws.addEventListener('error', () => {
      // The `error` event carries no useful detail; `close` follows with a code.
      log.warn(`${this.stream}: socket error`)
    })

    // Typed structurally: Node's lib has no DOM `CloseEvent`.
    ws.addEventListener('close', (event: { code?: number }) => {
      this.ws = null
      if (this.closedByUs) {
        this.callbacks.onStateChange('closed')
        return
      }
      log.warn(`${this.stream}: closed (code=${event.code})`)
      this.scheduleReconnect()
    })
  }

  private handleMessage(raw: string): void {
    let msg: FluxMessage
    try {
      msg = JSON.parse(raw) as FluxMessage
    } catch {
      log.warn(`${this.stream}: unparseable message`)
      return
    }

    if (msg.type === 'Connected') {
      log.debug(`${this.stream}: request ${(msg as FluxConnected).request_id}`)
      return
    }

    if (msg.type === 'Error') {
      const e = msg as FluxError
      this.fail(`${e.code ?? 'error'}: ${e.description ?? 'unknown'}`)
      return
    }

    if (msg.type !== 'TurnInfo') return

    const turn = msg as FluxTurnInfo
    const phase = PHASE_OF[turn.event]
    if (!phase) return

    this.callbacks.onTurn({
      stream: this.stream,
      phase,
      turnIndex: turn.turn_index,
      transcript: turn.transcript ?? '',
      endOfTurnConfidence: Number(turn.end_of_turn_confidence ?? 0),
      audioWindowEnd: Number(turn.audio_window_end ?? 0),
      observedAt: now(),
    })
  }

  private fail(detail: string): void {
    log.error(`${this.stream}: ${detail}`)
    this.callbacks.onStateChange('error', detail)
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.reconnectTimer) return
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)] ?? 8000
    this.attempt++
    this.callbacks.onStateChange('reconnecting', `retry in ${delay}ms`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private rawSend(frame: ArrayBuffer): void {
    try {
      this.ws?.send(frame)
    } catch (err) {
      log.warn(`${this.stream}: send failed`, err)
    }
  }

  send(frame: ArrayBuffer | Buffer): void {
    const buf =
      frame instanceof ArrayBuffer
        ? frame
        : (frame.buffer.slice(
            frame.byteOffset,
            frame.byteOffset + frame.byteLength
          ) as ArrayBuffer)

    if (this.connected) {
      this.rawSend(buf)
      return
    }
    // Drop the oldest rather than the newest: recent audio is what carries the
    // question we still have a chance of answering.
    this.pending.push(buf)
    if (this.pending.length > FluxSession.MAX_PENDING) this.pending.shift()
  }

  close(): void {
    this.closedByUs = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.pending = []
    const ws = this.ws
    this.ws = null
    if (!ws) return
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'CloseStream' }))
      ws.close()
    } catch {
      /* already gone */
    }
  }
}

export class DeepgramFluxProvider implements STTProvider {
  readonly name = 'deepgram-flux'

  readonly capabilities: STTCapabilities = {
    streaming: true,
    nativeTurnDetection: true,
    eagerEndOfTurn: true,
    sampleRate: AUDIO.sampleRate,
    supportsKeyterms: true,
  }

  validate(): void {
    if (!getCredential('DEEPGRAM_API_KEY')) {
      throw new Error(
        'DEEPGRAM_API_KEY is not set. Add it in Settings, or put it in a .env file at the project root.'
      )
    }
  }

  createSession(options: STTSessionOptions, callbacks: STTSessionCallbacks): STTSession {
    const key = getCredential('DEEPGRAM_API_KEY')
    if (!key) throw new Error('DEEPGRAM_API_KEY is not set.')
    return new FluxSession(key, options, callbacks)
  }
}
