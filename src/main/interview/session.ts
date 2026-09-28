/**
 * Session orchestration: owns the live STT connections, the turn engine and the
 * conversation context for one interview.
 *
 * Startup order is deliberate. Sockets and the LLM connection pool are opened
 * *before* any audio arrives, because a cold Flux connect measured ~910 ms and a
 * cold Groq request ~545 ms. Paying that during setup instead of on the first
 * question is the difference between a good demo and a bad one.
 */

import { createLogger } from '@main/core/logger'
import { getLlmProvider, getSttProvider } from '@main/providers/factory'
import { credentialStatus } from '@main/config/credentials'
import type { STTSession } from '@main/contracts/stt'
import type { LlmChoice } from '@main/interview/turn-engine'
import type { ToastPayload } from '@shared/ipc'
import { ContextManager } from '@main/interview/context-manager'
import { TurnEngine, type TurnEngineEvents } from '@main/interview/turn-engine'
import { getSettings } from '@main/config/settings'
import type {
  CandidateProfile,
  ListenState,
  SessionConfig,
  SessionState,
  StreamId,
  StreamStatus,
  TransportState,
} from '@shared/types'

const log = createLogger('session')

/**
 * Model used for off-critical-path work (summarization, resume parsing):
 * cheapest and fastest per provider.
 */
export const SUMMARY_MODELS: Record<string, string> = {
  groq: 'openai/gpt-oss-20b',
  openai: 'gpt-4o-mini',
  openrouter: 'openai/gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
}

export interface SessionEvents extends TurnEngineEvents {
  streamStatus(stream: StreamId, status: Partial<StreamStatus>): void
  sessionState(state: SessionState, error?: string): void
  /** Surface a main-process condition (STT/LLM failure, provider fallback) to the UI. */
  toast(payload: ToastPayload): void
}

export class InterviewSession {
  readonly context = new ContextManager()
  private engine: TurnEngine | null = null
  private sttSessions = new Map<StreamId, STTSession>()
  private state: SessionState = 'stopped'

  constructor(private readonly events: SessionEvents) {}

  get sessionState(): SessionState {
    return this.state
  }

  get turnEngine(): TurnEngine | null {
    return this.engine
  }

  setProfile(profile: CandidateProfile): void {
    this.context.setProfile(profile)
  }

  private setState(state: SessionState, error?: string): void {
    this.state = state
    this.events.sessionState(state, error)
  }

  async start(config: SessionConfig): Promise<{ ok: boolean; error?: string }> {
    if (this.state === 'running' || this.state === 'starting') return { ok: true }
    this.setState('starting')

    const settings = getSettings()

    let stt: ReturnType<typeof getSttProvider>
    let llm: ReturnType<typeof getLlmProvider>
    try {
      stt = getSttProvider(settings.providers.sttProvider)
      llm = getLlmProvider(settings.providers.llmProvider)
      // Fail loudly and early rather than at the first question.
      stt.validate()
      llm.validate()
    } catch (err) {
      const message = (err as Error).message
      log.error(`cannot start: ${message}`)
      this.setState('stopped', message)
      return { ok: false, error: message }
    }

    const answerModel = settings.providers.llmModel || llm.defaultModel
    const summaryModel = SUMMARY_MODELS[llm.name] ?? answerModel

    this.engine = new TurnEngine({
      llm,
      answerModel,
      summaryModel,
      context: this.context,
      config,
      emit: this.events,
      resolveFallback: (currentName) => this.resolveFallback(currentName),
    })

    // Keyterms bias the recognizer toward the candidate's own stack — a
    // mis-heard "Pinecone" produces a confidently wrong answer.
    const keyterms = this.context.getKeyterms()

    const streams: StreamId[] = ['system', 'mic']
    for (const stream of streams) {
      const session = stt.createSession(
        {
          stream,
          keyterms,
          eotThreshold: settings.providers.eotThreshold,
          eotTimeoutMs: settings.providers.eotTimeoutMs,
          // Only the interviewer channel needs speculation; the candidate
          // channel exists purely to feed memory, and eager events there would
          // just double the message volume.
          ...(stream === 'system' && config.speculative
            ? { eagerEotThreshold: settings.providers.eagerEotThreshold }
            : {}),
        },
        {
          onTurn: (event) => this.engine?.handleTurn(event),
          onStateChange: (transport, detail, terminal) => {
            this.events.streamStatus(stream, {
              transport: transport as TransportState,
              ...(detail ? { error: detail } : {}),
            })
            // A terminal transcription failure is silent otherwise — the audio
            // meters keep moving while nothing is ever transcribed. Say so.
            if (terminal) {
              const who = stream === 'system' ? 'Interviewer audio' : 'Microphone'
              this.events.toast({
                level: 'error',
                message: `${who} transcription stopped: ${detail ?? 'connection failed'}`,
              })
            }
          },
        }
      )
      this.sttSessions.set(stream, session)
    }

    // Open everything concurrently — no reason to serialize independent waits.
    await Promise.all([
      ...[...this.sttSessions.values()].map((s) => s.connect()),
      llm.prewarm(answerModel).catch((err) => log.warn('llm prewarm failed', err)),
    ])

    this.setState('running')
    // Tell the UI the starting listen indicator (e.g. "off" for manual, "always"
    // for always-on) now that a fresh engine exists.
    this.engine.notifyListenState()
    log.info(
      `session started — stt=${stt.name} llm=${llm.name}/${answerModel} ` +
        `speculative=${config.speculative} mode=${config.mode} listen=${config.listenMode}`
    )
    return { ok: true }
  }

  /** Hot path. Called ~12×/s per stream; must stay allocation-light. */
  routeFrame(stream: StreamId, frame: ArrayBuffer): void {
    this.sttSessions.get(stream)?.send(frame)
  }

  updateConfig(config: SessionConfig): void {
    this.engine?.updateConfig(config)
  }

  /** Push-to-listen control from the UI (hold button / arm shortcut). */
  setListen(state: ListenState): void {
    this.engine?.setListen(state)
  }

  /**
   * Pick another configured LLM provider to fall back to, skipping the one that
   * just failed. Order favours speed, then breadth. Returns null when nothing
   * else is set up — the primary error then surfaces as before.
   */
  private resolveFallback(currentName: string): LlmChoice | null {
    const status = credentialStatus()
    const order: Array<{ name: string; has: boolean }> = [
      { name: 'groq', has: status.groq },
      { name: 'openrouter', has: status.openrouter },
      { name: 'anthropic', has: status.anthropic },
      { name: 'openai', has: status.openai },
    ]
    for (const { name, has } of order) {
      if (name === currentName || !has) continue
      try {
        const provider = getLlmProvider(name)
        provider.validate()
        return { llm: provider, model: provider.defaultModel, name: provider.name }
      } catch {
        // Configured but unusable (e.g. a bad key) — try the next one.
      }
    }
    return null
  }

  stop(): void {
    if (this.state === 'stopped') return
    this.setState('stopping')
    this.engine?.reset()
    for (const session of this.sttSessions.values()) session.close()
    this.sttSessions.clear()
    this.engine = null
    this.setState('stopped')
    log.info('session stopped')
  }

  /** Wipes conversation memory without tearing down the connections. */
  clearMemory(): void {
    this.context.clear()
    this.engine?.reset()
  }
}
