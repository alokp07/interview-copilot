/**
 * The turn engine — where the latency is actually won.
 *
 * The core trick: when Flux reports an *eager* end-of-turn (it is moderately
 * confident the interviewer has stopped, 150-250 ms before it is certain), we
 * immediately gate the text and start generating. Three things can happen next:
 *
 *   • `TurnResumed` — the interviewer kept talking. Abort the generation, tell
 *     the UI to drop it, wait for the real end.
 *   • `EndOfTurn` with substantially the same text — *promote* the speculation.
 *     The answer is already streaming, so the user sees tokens that started
 *     before the interviewer even finished. This is the negative-latency case.
 *   • `EndOfTurn` with different text — the tail changed the question. Abort and
 *     regenerate from the final transcript.
 *
 * Exactly one generation is ever active. Every async continuation re-checks that
 * it still owns `active` before emitting, because cancellation races are the
 * defining bug class of this design.
 */

import { randomUUID } from 'node:crypto'
import { createLogger } from '@main/core/logger'
import { LatencyStats, TraceRecorder, now } from '@main/core/trace'
import type { LLMProvider } from '@main/contracts/llm'
import { ContextManager } from '@main/interview/context-manager'
import { classify, normalizeQuestion, similarity } from '@main/interview/question-gate'
import type {
  AnswerCancelled,
  AnswerDone,
  AnswerError,
  AnswerNudge,
  DetectedQuestion,
  ListenIndicator,
  ListenState,
  SessionConfig,
  Speaker,
  TranscriptLine,
  TurnEvent,
  TurnTrace,
} from '@shared/types'
import { SPEAKER_OF } from '@shared/types'

const log = createLogger('turn-engine')

/** A promoted speculation must still be asking essentially the same thing. */
const PROMOTE_SIMILARITY = 0.85
/** Suppress a repeat question inside this window. */
const DEDUPE_WINDOW_MS = 90_000
const DEDUPE_SIMILARITY = 0.9
/** First token goes out immediately; the rest coalesce to one frame's worth. */
const DELTA_FLUSH_MS = 25

/** A provider the engine can fall back to when the primary fails outright. */
export interface LlmChoice {
  llm: LLMProvider
  model: string
  name: string
}

export interface TurnEngineDeps {
  llm: LLMProvider
  /** Cheap model for off-critical-path summarization. */
  summaryModel: string
  answerModel: string
  context: ContextManager
  config: SessionConfig
  emit: TurnEngineEvents
  /**
   * Given the failing provider's name, return another configured provider to try
   * (or null). Only consulted before any token has shipped, so a fallback never
   * restarts an answer mid-sentence.
   */
  resolveFallback?: (currentProviderName: string) => LlmChoice | null
}

export interface TurnEngineEvents {
  transcript(line: TranscriptLine): void
  interim(speaker: Speaker, text: string): void
  question(question: DetectedQuestion): void
  answerDelta(questionId: string, delta: string): void
  answerDone(payload: AnswerDone): void
  answerCancelled(payload: AnswerCancelled): void
  answerError(payload: AnswerError): void
  listenState(indicator: ListenIndicator): void
  /** Optional: surface a main-process condition (e.g. a provider fallback) to the UI. */
  toast?(payload: { level: 'info' | 'warn' | 'error'; message: string }): void
  trace(trace: TurnTrace): void
}

interface ActiveGeneration {
  questionId: string
  questionText: string
  controller: AbortController
  trace: TraceRecorder
  speculative: boolean
  text: string
  /** Buffered deltas awaiting the coalescing flush. */
  pending: string
  flushTimer: NodeJS.Timeout | null
  firstTokenSent: boolean
}

/**
 * A speculative generation that already finished streaming but whose question
 * has not yet been confirmed. At 500 tok/s a short answer can complete inside
 * the 150-250 ms head start, so "already done" is a normal outcome, not an edge
 * case — and it still has to be either confirmed or replaced.
 */
interface PendingSpeculation {
  questionId: string
  questionText: string
  trace: TraceRecorder
}

export class TurnEngine {
  private active: ActiveGeneration | null = null
  private pendingSpeculation: PendingSpeculation | null = null
  private lastQuestion: { text: string; id: string } | null = null
  private recentQuestions: Array<{ norm: string; at: number }> = []
  /**
   * Push-to-listen state, driven from the UI in manual mode. In `always` mode it
   * is ignored — the gate below is open regardless. Kept out of `config` because
   * it changes many times a second (a held button) and must not churn settings.
   */
  private listen: ListenState = 'idle'
  readonly stats = new LatencyStats()

  /** Per-stream working state for the current turn. */
  private turnState = new Map<
    string,
    { index: number; speechStart: number; eagerText: string; eagerAt: number }
  >()

  constructor(private deps: TurnEngineDeps) {}

  updateConfig(config: SessionConfig): void {
    const modeChanged = this.deps.config.listenMode !== config.listenMode
    this.deps.config = config
    // Switching to `always` opens the gate; switching to `manual` re-arms the
    // idle default. Either way the indicator the UI shows may have changed.
    if (modeChanged) this.emitListenState()
  }

  // -------------------------------------------------------------------------
  // Push-to-listen
  // -------------------------------------------------------------------------

  /** Whether an interviewer turn is currently allowed to produce an answer. */
  private get isListening(): boolean {
    return this.deps.config.listenMode === 'always' || this.listen !== 'idle'
  }

  /** Resolved state for the UI, so the renderer never recombines mode + state. */
  private get listenIndicator(): ListenIndicator {
    if (this.deps.config.listenMode === 'always') return 'always'
    if (this.listen === 'holding') return 'listening'
    if (this.listen === 'armed') return 'armed'
    return 'off'
  }

  private emitListenState(): void {
    this.deps.emit.listenState(this.listenIndicator)
  }

  /** Re-broadcast the current indicator — used right after a session starts. */
  notifyListenState(): void {
    this.emitListenState()
  }

  setListen(state: ListenState): void {
    if (this.listen === state) return
    this.listen = state
    this.emitListenState()
  }

  /**
   * Consume a one-shot arm the moment we commit to answering a real (confirmed)
   * question, dropping back to idle. Holding is never consumed — it ends only
   * when the button is released.
   */
  private consumeArm(): void {
    if (this.listen === 'armed') {
      this.listen = 'idle'
      this.emitListenState()
    }
  }

  updateModels(answerModel: string, summaryModel: string): void {
    this.deps.answerModel = answerModel
    this.deps.summaryModel = summaryModel
  }

  // -------------------------------------------------------------------------
  // Turn events
  // -------------------------------------------------------------------------

  handleTurn(event: TurnEvent): void {
    const speaker = SPEAKER_OF[event.stream]
    if (speaker === 'candidate') {
      this.handleCandidateTurn(event)
      return
    }
    this.handleInterviewerTurn(event)
  }

  /**
   * The candidate's own channel never triggers generation — it only feeds
   * memory, so the model does not contradict what they already said out loud.
   */
  private handleCandidateTurn(event: TurnEvent): void {
    if (event.phase === 'update') {
      this.deps.emit.interim('candidate', event.transcript)
      return
    }
    if (event.phase === 'end' && event.transcript.trim()) {
      this.deps.context.recordTurn('candidate', event.transcript)
      this.deps.emit.transcript({
        id: randomUUID(),
        speaker: 'candidate',
        text: event.transcript.trim(),
        final: true,
        at: Date.now(),
      })
      this.deps.emit.interim('candidate', '')
    }
  }

  private stateFor(event: TurnEvent): {
    index: number
    speechStart: number
    eagerText: string
    eagerAt: number
  } {
    const key = `${event.stream}:${event.turnIndex}`
    let state = this.turnState.get(key)
    if (!state) {
      state = { index: event.turnIndex, speechStart: event.observedAt, eagerText: '', eagerAt: 0 }
      this.turnState.set(key, state)
      // Turn indices only grow; drop stale entries so this can't leak.
      if (this.turnState.size > 8) {
        const oldest = this.turnState.keys().next().value
        if (oldest) this.turnState.delete(oldest)
      }
    }
    return state
  }

  private handleInterviewerTurn(event: TurnEvent): void {
    const state = this.stateFor(event)

    switch (event.phase) {
      case 'start':
        state.speechStart = event.observedAt
        this.deps.emit.interim('interviewer', event.transcript)
        return

      case 'update':
        this.deps.emit.interim('interviewer', event.transcript)
        return

      case 'eager-end': {
        if (!this.deps.config.speculative) return
        // Manual mode, not listening: don't even speculate. Memory still records
        // the turn on `end` below, so context is never lost between presses.
        if (!this.isListening) return
        state.eagerText = event.transcript
        state.eagerAt = event.observedAt
        this.considerQuestion(event.transcript, {
          speculative: true,
          speechStart: state.speechStart,
          eagerAt: event.observedAt,
        })
        return
      }

      case 'resumed': {
        // The interviewer carried on — whatever we speculated is now wrong,
        // whether it is still streaming or already finished.
        state.eagerText = ''
        if (this.active?.speculative) {
          log.debug('turn resumed; discarding speculation')
          this.cancelActive('turn-resumed')
        } else if (this.pendingSpeculation) {
          const stale = this.pendingSpeculation
          this.pendingSpeculation = null
          this.deps.emit.answerCancelled({ questionId: stale.questionId, reason: 'turn-resumed' })
        }
        return
      }

      case 'end': {
        const finalText = event.transcript.trim()
        this.deps.emit.interim('interviewer', '')

        if (finalText) {
          this.deps.context.recordTurn('interviewer', finalText)
          this.deps.emit.transcript({
            id: randomUUID(),
            speaker: 'interviewer',
            text: finalText,
            final: true,
            at: Date.now(),
          })
        }

        // Can we keep the speculation, whether it is still streaming or has
        // already finished?
        const current = this.active
        if (state.eagerText) {
          const sim = similarity(state.eagerText, finalText)
          const matches = sim >= PROMOTE_SIMILARITY

          if (current?.speculative) {
            if (matches) {
              current.speculative = false
              current.trace.mark('speechEnd', event.observedAt)
              current.trace.reset('speculationHit', true)
              this.confirm(current.questionId, current.questionText)
              log.info(`speculation promoted mid-stream (similarity ${sim.toFixed(2)})`)
              return
            }
            log.debug(`speculation stale (similarity ${sim.toFixed(2)}); regenerating`)
            this.cancelActive('superseded')
          } else if (!current && this.pendingSpeculation) {
            const pending = this.pendingSpeculation
            this.pendingSpeculation = null
            if (matches) {
              // The answer is already fully on screen. Confirm it and settle the
              // trace that was deliberately held back until now.
              pending.trace.mark('speechEnd', event.observedAt)
              pending.trace.reset('speculationHit', true)
              this.confirm(pending.questionId, pending.questionText)
              this.settleTrace(pending.trace)
              log.info(
                `speculation confirmed after completing (similarity ${sim.toFixed(2)}) — ` +
                  'the answer was ready before the question ended'
              )
              return
            }
            log.debug(
              `completed speculation was for a different question (similarity ${sim.toFixed(2)})`
            )
          }
        }

        this.considerQuestion(finalText, {
          speculative: false,
          speechStart: state.speechStart,
          speechEnd: event.observedAt,
        })
        return
      }

      default:
        return
    }
  }

  // -------------------------------------------------------------------------
  // Question gating
  // -------------------------------------------------------------------------

  private considerQuestion(
    raw: string,
    timing: { speculative: boolean; speechStart: number; eagerAt?: number; speechEnd?: number }
  ): void {
    // Push-to-listen gate. In manual mode an interviewer turn only becomes an
    // answer while armed or held; otherwise it silently feeds memory and stops
    // here. `askManual`/`regenerate` bypass this by never calling in.
    if (!this.isListening) return

    const gateStart = now()
    const verdict = classify(raw)

    if (!verdict.isQuestion) {
      log.debug(`not a question (${verdict.reason}): "${truncate(raw)}"`)
      return
    }

    if (this.isDuplicate(verdict.text)) {
      log.debug(`duplicate question suppressed: "${truncate(verdict.text)}"`)
      return
    }

    // A confirmed turn always supersedes whatever is in flight.
    if (this.active) {
      if (timing.speculative) return // never let a speculation replace live work
      this.cancelActive('superseded')
    }

    // Starting fresh work retires any completed-but-unconfirmed speculation.
    this.pendingSpeculation = null

    const questionId = randomUUID()
    const trace = new TraceRecorder(questionId)
    trace.mark('speechStart', timing.speechStart)
    if (timing.eagerAt) trace.mark('eagerEnd', timing.eagerAt)
    if (timing.speechEnd) trace.mark('speechEnd', timing.speechEnd)
    trace.mark('gated', gateStart)

    // A confirmed question is the one an arm was waiting for — consume it now so
    // the candidate isn't answered a second time until they re-arm. Speculative
    // gating waits for confirmation via `confirm()` so a dropped guess keeps the arm.
    if (!timing.speculative) this.consumeArm()

    this.lastQuestion = { text: verdict.text, id: questionId }
    this.recentQuestions.push({ norm: normalizeQuestion(verdict.text), at: Date.now() })

    this.deps.emit.question({
      id: questionId,
      text: verdict.text,
      confidence: verdict.confidence,
      reason: verdict.reason,
      speculative: timing.speculative,
      at: Date.now(),
    })

    void this.generate(questionId, verdict.text, trace, timing.speculative)
  }

  /** Tell the UI a question is no longer a guess, without disturbing the answer. */
  private confirm(questionId: string, questionText: string): void {
    // A promoted speculation is a confirmed answer to the awaited question.
    this.consumeArm()
    this.deps.emit.question({
      id: questionId,
      text: questionText,
      confidence: 'high',
      reason: 'promoted-speculation',
      speculative: false,
      at: Date.now(),
    })
  }

  private settleTrace(trace: TraceRecorder): void {
    const snapshot = trace.snapshot
    this.stats.add(trace.summarize())
    this.deps.emit.trace(snapshot)
  }

  private isDuplicate(text: string): boolean {
    const cutoff = Date.now() - DEDUPE_WINDOW_MS
    this.recentQuestions = this.recentQuestions.filter((q) => q.at >= cutoff)
    const norm = normalizeQuestion(text)
    return this.recentQuestions.some((q) => similarity(q.norm, norm) >= DEDUPE_SIMILARITY)
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  /** Manual override: the candidate types or pastes a question. */
  askManual(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.cancelActive('superseded')
    const questionId = randomUUID()
    const trace = new TraceRecorder(questionId)
    trace.mark('speechEnd', now())
    trace.mark('gated', now())
    this.lastQuestion = { text: trimmed, id: questionId }
    this.deps.emit.question({
      id: questionId,
      text: trimmed,
      confidence: 'high',
      reason: 'manual',
      speculative: false,
      at: Date.now(),
    })
    void this.generate(questionId, trimmed, trace, false)
  }

  /**
   * Re-answer the last question, optionally with a live register shift
   * ("simpler"/"deeper") — the mid-interview escape hatch for an answer that
   * came out pitched wrong.
   */
  regenerate(nudge?: AnswerNudge): void {
    if (!this.lastQuestion) return
    const { text } = this.lastQuestion
    this.cancelActive('superseded')
    // Regeneration is an explicit user act, so bypass the duplicate filter.
    const questionId = randomUUID()
    const trace = new TraceRecorder(questionId)
    trace.mark('speechEnd', now())
    trace.mark('gated', now())
    this.lastQuestion = { text, id: questionId }
    this.deps.emit.question({
      id: questionId,
      text,
      confidence: 'high',
      reason: nudge ? `regenerate-${nudge}` : 'regenerate',
      speculative: false,
      at: Date.now(),
    })
    void this.generate(questionId, text, trace, false, nudge)
  }

  private async generate(
    questionId: string,
    questionText: string,
    trace: TraceRecorder,
    speculative: boolean,
    nudge?: AnswerNudge
  ): Promise<void> {
    const controller = new AbortController()
    const generation: ActiveGeneration = {
      questionId,
      questionText,
      controller,
      trace,
      speculative,
      text: '',
      pending: '',
      flushTimer: null,
      firstTokenSent: false,
    }
    this.active = generation

    const messages = this.deps.context.buildMessages(questionText, this.deps.config, nudge)
    const maxTokens = this.deps.config.answerLength === 'detailed' ? 420 : 260

    // The primary provider, plus one configured fallback if the primary dies
    // before shipping a token. Resolved up front so the list is stable.
    const providers: LlmChoice[] = [
      { llm: this.deps.llm, model: this.deps.answerModel, name: this.deps.llm.name },
    ]
    if (this.deps.config.providerFallback && this.deps.resolveFallback) {
      const fb = this.deps.resolveFallback(this.deps.llm.name)
      if (fb && fb.name !== this.deps.llm.name) providers.push(fb)
    }

    trace.mark('llmRequest')

    let lastError: { message: string; retryable: boolean } | null = null

    for (let p = 0; p < providers.length; p++) {
      const provider = providers[p]!
      trace.reset('model', provider.model)

      // At most one retry per provider, and only before any token has shipped —
      // the user must never watch an answer restart mid-sentence.
      for (let attempt = 0; attempt <= 1; attempt++) {
        const outcome = await this.runStream(generation, messages, maxTokens, provider)
        if (outcome === 'done' || outcome === 'abandoned') return
        if (outcome === 'retry') {
          log.warn(`retrying generation for ${questionId} on ${provider.name}`)
          continue
        }
        // A concrete failure this provider can't recover from.
        lastError = outcome.failed
        break
      }

      // Once a token has shipped we can't switch providers without restarting the
      // answer on screen, so a mid-stream failure is terminal here.
      if (generation.firstTokenSent) break

      const next = providers[p + 1]
      if (next) {
        log.warn(`provider ${provider.name} failed; falling back to ${next.name}`)
        this.deps.emit.toast?.({
          level: 'warn',
          message: `${provider.name} failed — switching to ${next.name}.`,
        })
        // Clean slate for the fallback attempt.
        generation.text = ''
        generation.pending = ''
      }
    }

    if (this.active === generation) {
      this.active = null
      this.deps.emit.answerError({
        questionId,
        message:
          lastError?.message ??
          'The model failed. Check the connection or switch provider.',
        retryable: lastError?.retryable ?? true,
      })
    }
  }

  /**
   * One attempt at a generation against a single provider. Returns `retry` for a
   * transient failure before any output reached the user, `abandoned` if the
   * generation was cancelled underneath us, `done` on success, or a `failed`
   * result the caller decides how to surface (error or fall back).
   */
  private async runStream(
    generation: ActiveGeneration,
    messages: ReturnType<ContextManager['buildMessages']>,
    maxTokens: number,
    provider: LlmChoice
  ): Promise<'done' | 'retry' | 'abandoned' | { failed: { message: string; retryable: boolean } }> {
    const { questionId, controller, trace } = generation
    let sawTerminal = false

    try {
      for await (const event of provider.llm.stream({
        messages,
        model: provider.model,
        maxTokens,
        // Grounded mode is a constraint-following task, and adherence improves
        // at lower sampling entropy; the voice survives fine at 0.35.
        temperature: this.deps.config.grounded ? 0.35 : 0.5,
        signal: controller.signal,
      })) {
        // Ownership check: a cancellation may have landed between chunks.
        if (this.active !== generation || controller.signal.aborted) return 'abandoned'

        if (event.type === 'delta' && event.text) {
          generation.text += event.text
          if (!generation.firstTokenSent) {
            trace.mark('firstToken')
            generation.firstTokenSent = true
            // The headline metric — never batched.
            this.deps.emit.answerDelta(questionId, event.text)
          } else {
            this.bufferDelta(generation, event.text)
          }
          continue
        }

        if (event.type === 'error') {
          sawTerminal = true
          this.flushDelta(generation)
          if (event.retryable && !generation.firstTokenSent) {
            log.warn(`llm error (will retry): ${event.message}`)
            return 'retry'
          }
          log.error(`llm error: ${event.message}`)
          return { failed: { message: event.message ?? 'Generation failed', retryable: Boolean(event.retryable) } }
        }

        if (event.type === 'done') {
          sawTerminal = true
          this.finish(generation, event.promptTokens, event.completionTokens)
          return 'done'
        }
      }
    } catch (err) {
      if (controller.signal.aborted || this.active !== generation) return 'abandoned'
      log.error('generation threw', err)
      if (!generation.firstTokenSent) return 'retry'
      this.flushDelta(generation)
      return { failed: { message: (err as Error).message, retryable: true } }
    }

    // The stream ended without a terminal event. If we got usable text, treat
    // it as complete rather than stranding the UI in "streaming" forever.
    if (!sawTerminal && this.active === generation) {
      if (generation.text.trim()) {
        this.finish(generation)
        return 'done'
      }
      return generation.firstTokenSent ? 'done' : 'retry'
    }
    return 'done'
  }

  private finish(
    generation: ActiveGeneration,
    promptTokens?: number,
    completionTokens?: number
  ): void {
    const { trace, questionId } = generation
    this.flushDelta(generation)
    trace.mark('complete')
    // Guard against `undefined`: an explicitly-passed undefined would trigger
    // `mark`'s default parameter and stamp a timestamp into a token count.
    if (promptTokens !== undefined) trace.reset('promptTokens', promptTokens)
    if (completionTokens !== undefined) trace.reset('completionTokens', completionTokens)
    if (this.active === generation) this.active = null

    const snapshot = trace.snapshot
    this.deps.emit.answerDone({ questionId, text: generation.text, trace: snapshot })

    if (generation.speculative) {
      // Finished before the turn was confirmed. Hold the trace until we know
      // whether this answer survives, so the latency stats only ever count
      // answers the candidate actually got to use.
      this.pendingSpeculation = {
        questionId,
        questionText: generation.questionText,
        trace,
      }
    } else {
      this.settleTrace(trace)
    }
    log.info(`answer complete\n${trace.format()}`)

    this.deps.context.recordTurn('candidate', generation.text)
    // Strictly after delivery, so it can never delay an answer.
    void this.deps.context.maybeSummarize(this.deps.llm, this.deps.summaryModel)
  }

  /**
   * Coalesces tokens after the first. At 500 tok/s a per-token IPC message would
   * mean 500 renders a second for no visible benefit; the first token still goes
   * out immediately because that is the number the product is measured on.
   */
  private bufferDelta(generation: ActiveGeneration, text: string): void {
    generation.pending += text
    if (generation.flushTimer) return
    generation.flushTimer = setTimeout(() => {
      generation.flushTimer = null
      this.flushDelta(generation)
    }, DELTA_FLUSH_MS)
  }

  private flushDelta(generation: ActiveGeneration): void {
    if (generation.flushTimer) {
      clearTimeout(generation.flushTimer)
      generation.flushTimer = null
    }
    if (!generation.pending) return
    const pending = generation.pending
    generation.pending = ''
    if (this.active === generation || generation.text.endsWith(pending)) {
      this.deps.emit.answerDelta(generation.questionId, pending)
    }
  }

  cancelActive(reason: AnswerCancelled['reason']): void {
    const generation = this.active
    if (!generation) return
    this.active = null
    if (generation.flushTimer) {
      clearTimeout(generation.flushTimer)
      generation.flushTimer = null
    }
    generation.controller.abort()
    this.deps.emit.answerCancelled({ questionId: generation.questionId, reason })
    log.debug(`generation cancelled (${reason})`)
  }

  get isGenerating(): boolean {
    return this.active !== null
  }

  reset(): void {
    this.cancelActive('session-stopped')
    this.pendingSpeculation = null
    this.turnState.clear()
    this.recentQuestions = []
    this.lastQuestion = null
    this.listen = 'idle'
    this.emitListenState()
    this.stats.reset()
  }
}

function truncate(text: string, max = 60): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
