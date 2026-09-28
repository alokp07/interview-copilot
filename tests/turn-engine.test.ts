/**
 * The turn engine is the highest-risk component in the system: speculation,
 * cancellation and promotion all race each other. These tests drive it with a
 * scripted LLM so the timing is deterministic.
 */

import { describe, expect, it, vi } from 'vitest'
import { TurnEngine, type TurnEngineEvents } from '@main/interview/turn-engine'
import { ContextManager } from '@main/interview/context-manager'
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '@main/contracts/llm'
import type { SessionConfig, TurnEvent, TurnPhase } from '@shared/types'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class ScriptedLLM implements LLMProvider {
  readonly name = 'scripted'
  readonly defaultModel = 'test-model'
  readonly capabilities = { streaming: true, promptCaching: false, maxContextTokens: 8000 }

  calls: LLMRequest[] = []
  /** Resolves once a generation has actually started streaming. */
  started = 0
  aborted = 0

  constructor(
    private chunks: string[] = ['Because ', 'the schema ', 'was flexible.'],
    private delayMs = 1
  ) {}

  validate(): void {}
  async prewarm(): Promise<void> {}

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.calls.push(request)
    this.started++
    for (const chunk of this.chunks) {
      await new Promise((r) => setTimeout(r, this.delayMs))
      if (request.signal.aborted) {
        this.aborted++
        return
      }
      yield { type: 'delta', text: chunk }
    }
    yield { type: 'done', promptTokens: 100, completionTokens: 10 }
  }
}

class FailingLLM implements LLMProvider {
  readonly name = 'failing'
  readonly defaultModel = 'test-model'
  readonly capabilities = { streaming: true, promptCaching: false, maxContextTokens: 8000 }
  attempts = 0

  constructor(private readonly retryable: boolean) {}

  validate(): void {}
  async prewarm(): Promise<void> {}

  async *stream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    void _request
    this.attempts++
    yield { type: 'error', message: 'provider exploded', retryable: this.retryable }
  }
}

function recorder(): TurnEngineEvents & {
  questions: Array<{ id: string; text: string; speculative: boolean }>
  deltas: string[]
  done: string[]
  cancelled: Array<{ questionId: string; reason: string }>
  errors: string[]
  answerText: () => string
} {
  const questions: Array<{ id: string; text: string; speculative: boolean }> = []
  const deltas: string[] = []
  const done: string[] = []
  const cancelled: Array<{ questionId: string; reason: string }> = []
  const errors: string[] = []

  return {
    questions,
    deltas,
    done,
    cancelled,
    errors,
    answerText: () => deltas.join(''),
    transcript: () => {},
    interim: () => {},
    question: (q) => questions.push({ id: q.id, text: q.text, speculative: q.speculative }),
    answerDelta: (_id, delta) => deltas.push(delta),
    answerDone: (p) => done.push(p.text),
    answerCancelled: (p) => cancelled.push({ questionId: p.questionId, reason: p.reason }),
    answerError: (p) => errors.push(p.message),
    listenState: () => {},
    trace: () => {},
  }
}

// These tests exercise the always-answer engine behavior; push-to-listen gating
// gets its own block below with `listenMode: 'manual'`.
const CONFIG: SessionConfig = {
  mode: 'general',
  answerLength: 'normal',
  speculative: true,
  grounded: true,
  complexity: 'balanced',
  listenMode: 'always',
  providerFallback: true,
}

/**
 * Turn events carry `observedAt` on the same monotonic clock the tracer uses,
 * so the helper reads the real clock rather than inventing one — otherwise the
 * latency arithmetic under test is meaningless.
 */
function turn(phase: TurnPhase, transcript: string, stream: 'system' | 'mic' = 'system'): TurnEvent {
  const at = performance.now()
  return {
    stream,
    phase,
    turnIndex: 0,
    transcript,
    endOfTurnConfidence: phase === 'end' ? 0.9 : 0.5,
    observedAt: at,
    audioWindowEnd: at / 1000,
  }
}

function build(llm: LLMProvider = new ScriptedLLM()): {
  engine: TurnEngine
  events: ReturnType<typeof recorder>
  llm: LLMProvider
} {
  const events = recorder()
  const engine = new TurnEngine({
    llm,
    answerModel: 'test-model',
    summaryModel: 'test-model',
    context: new ContextManager(),
    config: CONFIG,
    emit: events,
  })
  return { engine, events, llm }
}

const settle = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------

describe('speculative generation', () => {
  it('starts generating on eager end-of-turn, before the turn is confirmed', async () => {
    const llm = new ScriptedLLM()
    const { engine, events } = build(llm)

    engine.handleTurn(turn('start', ''))
    engine.handleTurn(turn('update', 'why did you choose'))
    engine.handleTurn(turn('eager-end', 'why did you choose mongodb'))
    await settle()

    expect(llm.started).toBe(1)
    expect(events.questions[0]?.speculative).toBe(true)
  })

  it('promotes a still-streaming speculation when the confirmed text matches', async () => {
    // Slow enough that the generation is genuinely mid-flight when `end` lands.
    const llm = new ScriptedLLM(['a ', 'b ', 'c ', 'd'], 25)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('eager-end', 'why did you choose mongodb for that'))
    await settle(30)
    const idDuringSpeculation = events.questions[0]?.id
    expect(engine.isGenerating).toBe(true)

    engine.handleTurn(turn('end', 'why did you choose mongodb for that project'))
    await settle(150)

    // One generation total — the answer already on screen is kept.
    expect(llm.started).toBe(1)
    expect(events.cancelled).toHaveLength(0)
    // Same question id, now marked confirmed.
    expect(events.questions.at(-1)?.id).toBe(idDuringSpeculation)
    expect(events.questions.at(-1)?.speculative).toBe(false)
    expect(events.done).toHaveLength(1)
  })

  it('confirms a speculation that finished before the turn was confirmed', async () => {
    // With a fast model a short answer completes inside the head start, so this
    // is the common case, not an edge case.
    const llm = new ScriptedLLM(['done'], 1)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('eager-end', 'why did you choose mongodb for that'))
    await settle(40)
    expect(engine.isGenerating).toBe(false)
    expect(events.done).toHaveLength(1)

    engine.handleTurn(turn('end', 'why did you choose mongodb for that project'))
    await settle(40)

    // Must not regenerate an answer the candidate can already read.
    expect(llm.started).toBe(1)
    expect(events.questions.at(-1)?.speculative).toBe(false)
    expect(engine.stats.report().speculationHitRate).toBe(1)
  })

  it('discards a completed speculation when the interviewer resumes', async () => {
    const llm = new ScriptedLLM(['done'], 1)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('eager-end', 'why did you choose mongodb'))
    await settle(40)
    engine.handleTurn(turn('resumed', 'why did you choose mongodb over'))
    await settle(20)

    expect(events.cancelled.at(-1)?.reason).toBe('turn-resumed')
    // An unconfirmed speculation is never counted in the latency stats.
    expect(engine.stats.report().n).toBe(0)
  })

  it('cancels the speculation when the interviewer resumes talking', async () => {
    const llm = new ScriptedLLM(['a', 'b', 'c'], 15)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('eager-end', 'why did you choose mongodb'))
    await settle(10)
    engine.handleTurn(turn('resumed', 'why did you choose mongodb over'))
    await settle(40)

    expect(events.cancelled.at(-1)?.reason).toBe('turn-resumed')
    expect(engine.isGenerating).toBe(false)
    expect(events.done).toHaveLength(0)
  })

  it('cancels and regenerates when a mid-stream speculation turns out to be wrong', async () => {
    const llm = new ScriptedLLM(['a ', 'b ', 'c ', 'd'], 25)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('eager-end', 'why did you choose mongodb'))
    await settle(30)
    engine.handleTurn(turn('end', 'tell me about a time you led a difficult project'))
    await settle(200)

    expect(llm.started).toBe(2)
    expect(events.cancelled.at(0)?.reason).toBe('superseded')
    expect(events.questions.at(-1)?.text).toContain('difficult project')
  })

  it('regenerates when a completed speculation turns out to be wrong', async () => {
    const llm = new ScriptedLLM(['done'], 1)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('eager-end', 'why did you choose mongodb'))
    await settle(40)
    engine.handleTurn(turn('end', 'tell me about a time you led a difficult project'))
    await settle(60)

    expect(llm.started).toBe(2)
    expect(events.questions.at(-1)?.text).toContain('difficult project')
  })

  it('does not speculate when the feature is disabled', async () => {
    const llm = new ScriptedLLM()
    const events = recorder()
    const engine = new TurnEngine({
      llm,
      answerModel: 'm',
      summaryModel: 'm',
      context: new ContextManager(),
      config: { ...CONFIG, speculative: false },
      emit: events,
    })

    engine.handleTurn(turn('eager-end', 'why did you choose mongodb'))
    await settle()
    expect(llm.started).toBe(0)

    engine.handleTurn(turn('end', 'why did you choose mongodb'))
    await settle(60)
    expect(llm.started).toBe(1)
  })
})

describe('duplicate suppression', () => {
  it('does not answer the same question twice', async () => {
    const llm = new ScriptedLLM()
    const { engine } = build(llm)

    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(60)
    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(60)

    expect(llm.started).toBe(1)
  })

  it('answers a genuinely different question', async () => {
    const llm = new ScriptedLLM()
    const { engine } = build(llm)

    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(60)
    engine.handleTurn(turn('end', 'what is your experience with kubernetes'))
    await settle(60)

    expect(llm.started).toBe(2)
  })

  it('allows an explicit regenerate to bypass the duplicate filter', async () => {
    const llm = new ScriptedLLM()
    const { engine } = build(llm)

    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(60)
    engine.regenerate()
    await settle(60)

    expect(llm.started).toBe(2)
  })

  it('threads a live nudge into the regenerated request', async () => {
    const llm = new ScriptedLLM()
    const { engine } = build(llm)

    engine.handleTurn(turn('end', 'explain react reconciliation'))
    await settle(60)
    engine.regenerate('simpler')
    await settle(60)

    // The first request carried no rewrite line; the nudged one must.
    const first = llm.calls.at(0)!.messages.map((m) => m.content).join('\n')
    const nudged = llm.calls.at(1)!.messages.map((m) => m.content).join('\n')
    expect(first).not.toContain('Rewrite guidance')
    expect(nudged).toContain('Rewrite guidance')
    expect(nudged).toContain('plainer words')
    // Same question, not a new one.
    expect(llm.calls.at(1)!.messages.at(-1)?.content).toBe('explain react reconciliation')
  })
})

describe('speaker separation', () => {
  it('never generates an answer from the candidate channel', async () => {
    const llm = new ScriptedLLM()
    const { engine } = build(llm)

    // The candidate asking a question out loud must not trigger a self-answer.
    engine.handleTurn(turn('end', 'what do you think about that', 'mic'))
    engine.handleTurn(turn('eager-end', 'why did you choose mongodb', 'mic'))
    await settle(60)

    expect(llm.started).toBe(0)
  })

  it('feeds the candidate channel into conversation memory', async () => {
    const context = new ContextManager()
    const events = recorder()
    const engine = new TurnEngine({
      llm: new ScriptedLLM(),
      answerModel: 'm',
      summaryModel: 'm',
      context,
      config: CONFIG,
      emit: events,
    })

    engine.handleTurn(turn('end', 'I used mongodb because the schema kept changing', 'mic'))
    expect(context.turnCount).toBe(1)
  })
})

describe('interruption and cancellation', () => {
  it('supersedes an in-flight answer when a new question arrives', async () => {
    const llm = new ScriptedLLM(['one ', 'two ', 'three'], 20)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('end', 'what is a closure'))
    await settle(15)
    engine.handleTurn(turn('end', 'how does the event loop work'))
    await settle(120)

    expect(events.cancelled.at(0)?.reason).toBe('superseded')
    expect(events.questions.at(-1)?.text).toContain('event loop')
  })

  it('aborts the provider request rather than merely ignoring the result', async () => {
    const llm = new ScriptedLLM(['one ', 'two ', 'three'], 20)
    const { engine } = build(llm)

    engine.handleTurn(turn('end', 'what is a closure'))
    await settle(15)
    engine.cancelActive('user')
    await settle(80)

    // The generator observed the abort signal — cancellation stops billing,
    // it does not just drop output on the floor.
    expect(llm.aborted).toBeGreaterThan(0)
  })

  it('stops emitting deltas once cancelled', async () => {
    const llm = new ScriptedLLM(['one ', 'two ', 'three'], 20)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('end', 'what is a closure'))
    await settle(30)
    const before = events.deltas.length
    engine.cancelActive('user')
    await settle(100)

    expect(events.deltas.length).toBe(before)
  })
})

describe('provider failures', () => {
  it('retries once on a transient error', async () => {
    const llm = new FailingLLM(true)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(80)

    expect(llm.attempts).toBe(2)
    expect(events.errors).toHaveLength(1)
  })

  it('does not retry a non-transient error', async () => {
    const llm = new FailingLLM(false)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(80)

    expect(llm.attempts).toBe(1)
    expect(events.errors.at(0)).toContain('exploded')
  })

  it('falls back to another provider when the primary fails before any token', async () => {
    const primary = new FailingLLM(false)
    const fallback = new ScriptedLLM(['fallback ', 'answer'])
    const events = recorder()
    const toasts: string[] = []
    const engine = new TurnEngine({
      llm: primary,
      answerModel: 'm',
      summaryModel: 'm',
      context: new ContextManager(),
      config: CONFIG,
      emit: { ...events, toast: (t) => toasts.push(t.message) },
      resolveFallback: () => ({ llm: fallback, model: 'm2', name: 'fallback' }),
    })

    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(80)

    expect(fallback.started).toBe(1)
    expect(events.answerText()).toBe('fallback answer')
    expect(events.errors).toHaveLength(0)
    expect(toasts.some((m) => /switching to fallback/i.test(m))).toBe(true)
  })

  it('never falls back once a token has already shipped', async () => {
    // Primary streams one token, then dies — switching now would restart the
    // answer on screen, so the fallback must stay untouched.
    const fallback = new ScriptedLLM(['should ', 'not ', 'run'])
    const partialThenError: LLMProvider = {
      name: 'partial',
      defaultModel: 'm',
      capabilities: { streaming: true, promptCaching: false, maxContextTokens: 100 },
      validate: () => {},
      prewarm: async () => {},
      async *stream() {
        yield { type: 'delta', text: 'partial ' }
        yield { type: 'error', message: 'died mid-stream', retryable: true }
      },
    }
    const events = recorder()
    const engine = new TurnEngine({
      llm: partialThenError,
      answerModel: 'm',
      summaryModel: 'm',
      context: new ContextManager(),
      config: CONFIG,
      emit: events,
      resolveFallback: () => ({ llm: fallback, model: 'm2', name: 'fallback' }),
    })

    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(80)

    expect(fallback.started).toBe(0)
    expect(events.answerText()).toBe('partial ')
    expect(events.errors.at(0)).toContain('died mid-stream')
  })

  it('surfaces a thrown provider error instead of hanging', async () => {
    const exploding: LLMProvider = {
      name: 'boom',
      defaultModel: 'm',
      capabilities: { streaming: true, promptCaching: false, maxContextTokens: 100 },
      validate: () => {},
      prewarm: async () => {},
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('socket hang up')
      },
    }
    const { engine, events } = build(exploding)

    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(80)

    expect(events.errors.length).toBeGreaterThan(0)
    expect(engine.isGenerating).toBe(false)
  })
})

describe('manual control', () => {
  it('answers a typed question immediately', async () => {
    const llm = new ScriptedLLM()
    const { engine, events } = build(llm)

    engine.askManual('explain the CAP theorem')
    await settle(60)

    expect(llm.started).toBe(1)
    expect(events.questions.at(0)?.text).toBe('explain the CAP theorem')
    expect(events.done).toHaveLength(1)
  })

  it('ignores an empty manual question', async () => {
    const llm = new ScriptedLLM()
    const { engine } = build(llm)
    engine.askManual('   ')
    await settle(20)
    expect(llm.started).toBe(0)
  })
})

describe('push-to-listen (manual mode)', () => {
  const manual = (): {
    engine: TurnEngine
    events: ReturnType<typeof recorder>
    llm: ScriptedLLM
  } => {
    const events = recorder()
    const llm = new ScriptedLLM()
    const engine = new TurnEngine({
      llm,
      answerModel: 'm',
      summaryModel: 'm',
      context: new ContextManager(),
      config: { ...CONFIG, listenMode: 'manual' },
      emit: events,
    })
    return { engine, events, llm }
  }

  it('does not answer while idle', async () => {
    const { engine, llm } = manual()
    engine.handleTurn(turn('eager-end', 'why did you choose mongodb for that'))
    engine.handleTurn(turn('end', 'why did you choose mongodb for that project'))
    await settle(80)
    expect(llm.started).toBe(0)
  })

  it('still feeds conversation memory while idle', async () => {
    const context = new ContextManager()
    const events = recorder()
    const engine = new TurnEngine({
      llm: new ScriptedLLM(),
      answerModel: 'm',
      summaryModel: 'm',
      context,
      config: { ...CONFIG, listenMode: 'manual' },
      emit: events,
    })
    engine.handleTurn(turn('end', 'what is your experience with kubernetes'))
    await settle(40)
    // The interviewer turn was recorded even though it produced no answer.
    expect(context.turnCount).toBe(1)
  })

  it('answers the next question when armed, then disarms', async () => {
    const { engine, llm } = manual()
    engine.setListen('armed')

    engine.handleTurn(turn('end', 'tell me about a hard bug you fixed'))
    await settle(60)
    expect(llm.started).toBe(1)

    // Arm was one-shot: a second question is ignored until re-armed.
    engine.handleTurn(turn('end', 'what is your favourite database'))
    await settle(60)
    expect(llm.started).toBe(1)
  })

  it('emits the resolved indicator as the arm is consumed', async () => {
    const events = recorder()
    const indicators: string[] = []
    const llm = new ScriptedLLM()
    const engine = new TurnEngine({
      llm,
      answerModel: 'm',
      summaryModel: 'm',
      context: new ContextManager(),
      config: { ...CONFIG, listenMode: 'manual' },
      emit: { ...events, listenState: (i) => indicators.push(i) },
    })

    engine.setListen('armed')
    expect(indicators.at(-1)).toBe('armed')

    engine.handleTurn(turn('end', 'explain the CAP theorem'))
    await settle(60)
    // Auto-disarmed back to off once the question was committed.
    expect(indicators.at(-1)).toBe('off')
  })

  it('answers every question while holding', async () => {
    const { engine, llm } = manual()
    engine.setListen('holding')

    engine.handleTurn(turn('end', 'what is a closure'))
    await settle(60)
    engine.handleTurn(turn('end', 'how does the event loop work'))
    await settle(60)
    expect(llm.started).toBe(2)
  })

  it('lets manual ask and regenerate work even when idle', async () => {
    const { engine, llm } = manual()
    engine.askManual('explain the CAP theorem')
    await settle(60)
    expect(llm.started).toBe(1)

    engine.regenerate()
    await settle(60)
    expect(llm.started).toBe(2)
  })
})

describe('latency accounting', () => {
  it('records the speech-end → first-token gap and flags a speculation hit', async () => {
    const llm = new ScriptedLLM()
    const events = recorder()
    const traces: unknown[] = []
    const engine = new TurnEngine({
      llm,
      answerModel: 'm',
      summaryModel: 'm',
      context: new ContextManager(),
      config: CONFIG,
      emit: { ...events, trace: (t) => traces.push(t) },
    })

    engine.handleTurn(turn('eager-end', 'why did you choose mongodb for that'))
    await settle()
    engine.handleTurn(turn('end', 'why did you choose mongodb for that project'))
    await settle(80)

    const report = engine.stats.report()
    expect(report.n).toBe(1)
    expect(report.speculationHitRate).toBe(1)
    expect(traces).toHaveLength(1)
    // The head start is real: the first token predates the confirmed end of
    // the interviewer's turn, so the measured latency is negative.
    expect(report.p50).not.toBeNull()
    expect(report.p50!).toBeLessThan(0)
  })
})

describe('non-questions', () => {
  it('does not generate for acknowledgements', async () => {
    const llm = new ScriptedLLM()
    const { engine } = build(llm)
    engine.handleTurn(turn('end', 'okay'))
    engine.handleTurn(turn('end', 'got it'))
    engine.handleTurn(turn('end', 'makes sense'))
    await settle(60)
    expect(llm.started).toBe(0)
  })

  it('does not generate for an empty confirmed turn', async () => {
    const llm = new ScriptedLLM()
    const { engine } = build(llm)
    engine.handleTurn(turn('end', ''))
    await settle(40)
    expect(llm.started).toBe(0)
  })
})

describe('lifecycle', () => {
  it('reset cancels in-flight work and clears dedupe history', async () => {
    const llm = new ScriptedLLM(['a ', 'b ', 'c'], 20)
    const { engine, events } = build(llm)

    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(15)
    engine.reset()

    expect(events.cancelled.at(-1)?.reason).toBe('session-stopped')
    expect(engine.isGenerating).toBe(false)

    // The same question is answerable again after a reset.
    engine.handleTurn(turn('end', 'tell me about yourself'))
    await settle(100)
    expect(llm.started).toBe(2)
  })
})

describe('prompt construction', () => {
  it('keeps the prompt small even after a long interview', async () => {
    const context = new ContextManager()
    const events = recorder()
    const llm = new ScriptedLLM()
    const engine = new TurnEngine({
      llm,
      answerModel: 'm',
      summaryModel: 'm',
      context,
      config: CONFIG,
      emit: events,
    })

    context.setProfile({
      name: 'Alok',
      role: 'Full-stack engineer',
      yearsExperience: '3 years',
      skills: 'React, Node.js, Python, MongoDB',
      projects: 'AI visual novel app; PDF-to-podcast pipeline',
      education: 'B.Tech CSE, 2023',
      workExperience: 'Acme — Full-stack dev',
      resume: 'x'.repeat(20_000),
      jobDescription: 'y'.repeat(20_000),
      company: 'Acme',
      notes: '',
    })

    for (let i = 0; i < 30; i++) context.recordTurn(i % 2 === 0 ? 'interviewer' : 'candidate', `turn ${i} `.repeat(40))

    engine.handleTurn(turn('end', 'what is your favourite database'))
    await settle(60)

    const request = llm.calls.at(0)
    expect(request).toBeDefined()
    const tokens = context.estimateTokens(request!.messages)
    // A naive implementation would send the whole transcript plus the full
    // resume here, which is tens of thousands of tokens.
    expect(tokens).toBeLessThan(2500)
  })

  it('marks the stable blocks cacheable and the volatile ones not', async () => {
    const context = new ContextManager()
    const messages = context.buildMessages('what is a closure', CONFIG)
    expect(messages.some((m) => m.cacheable)).toBe(true)
    expect(messages.at(-1)?.role).toBe('user')
    expect(messages.at(-1)?.cacheable).toBeUndefined()
  })
})

describe('generation ordering', () => {
  it('emits the first token immediately and batches the rest', async () => {
    // The headline metric is time-to-first-token, so the first delta must not
    // wait on the coalescing timer.
    const llm = new ScriptedLLM(['A', 'B', 'C', 'D'], 1)
    const { engine, events } = build(llm)
    const spy = vi.spyOn(events, 'answerDelta')

    engine.handleTurn(turn('end', 'what is a closure'))
    await settle(80)

    expect(spy.mock.calls.at(0)?.[1]).toBe('A')
    expect(events.answerText()).toBe('ABCD')
    // Batching means fewer IPC messages than tokens.
    expect(spy.mock.calls.length).toBeLessThan(4)
  })
})
