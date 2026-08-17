/**
 * Context management is where cost and latency are controlled. The invariant
 * under test: prompt size stays bounded no matter how long the interview runs
 * or how much resume text is pasted in.
 */

import { describe, expect, it } from 'vitest'
import {
  ContextManager,
  buildProfileCard,
  extractKeyterms,
} from '@main/interview/context-manager'
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '@main/contracts/llm'
import type { CandidateProfile, SessionConfig } from '@shared/types'

const CONFIG: SessionConfig = { mode: 'general', answerLength: 'normal', speculative: true }

const PROFILE: CandidateProfile = {
  name: 'Alok',
  role: 'Senior Full-Stack Engineer',
  yearsExperience: '3 years',
  skills: 'React, Node.js, Python, MongoDB, AI systems, Pinecone, Kubernetes',
  projects: 'AI visual novel app; PDF-to-podcast pipeline',
  resume: 'Detailed resume text. '.repeat(500),
  jobDescription: 'We need someone who ships. '.repeat(500),
  company: 'Acme',
  notes: 'Mention the fintech background.',
}

class SummaryLLM implements LLMProvider {
  readonly name = 'summary'
  readonly defaultModel = 'm'
  readonly capabilities = { streaming: true, promptCaching: false, maxContextTokens: 8000 }
  calls: LLMRequest[] = []
  validate(): void {}
  async prewarm(): Promise<void> {}
  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    this.calls.push(request)
    yield { type: 'delta', text: 'Discussed MongoDB, React and the visual novel project.' }
    yield { type: 'done' }
  }
}

describe('profile compaction', () => {
  it('clips long free-text fields so a pasted resume cannot dominate the prompt', () => {
    const card = buildProfileCard(PROFILE)
    // Raw inputs are ~12k chars each; the card must be a small fraction of that.
    expect(PROFILE.resume.length).toBeGreaterThan(10_000)
    expect(card.length).toBeLessThan(4000)
    expect(card).toContain('Alok')
    expect(card).toContain('MongoDB')
  })

  it('omits empty fields entirely', () => {
    const card = buildProfileCard({
      ...PROFILE,
      company: '',
      notes: '',
      resume: '',
      jobDescription: '',
    })
    expect(card).not.toContain('Company')
    expect(card).not.toContain('Resume')
  })
})

describe('keyterm extraction', () => {
  it('pulls stack terms out for speech-recognition biasing', () => {
    const terms = extractKeyterms(PROFILE)
    // These are exactly the words a generic recognizer mangles, and a mangled
    // question produces a confidently wrong answer.
    expect(terms).toContain('MongoDB')
    expect(terms).toContain('Pinecone')
    expect(terms).toContain('Kubernetes')
  })

  it('rejects sentence-length fragments and filler words', () => {
    const terms = extractKeyterms({
      ...PROFILE,
      skills: 'React, and, the, a very long phrase that is really a whole sentence about things',
    })
    expect(terms).toContain('React')
    expect(terms).not.toContain('and')
    expect(terms.every((t) => t.split(/\s+/).length <= 3)).toBe(true)
  })

  it('caps the list', () => {
    const many = Array.from({ length: 200 }, (_, i) => `Tech${i}`).join(', ')
    expect(extractKeyterms({ ...PROFILE, skills: many }).length).toBeLessThanOrEqual(40)
  })
})

describe('prompt size', () => {
  it('stays bounded across a long interview', () => {
    const context = new ContextManager()
    context.setProfile(PROFILE)
    for (let i = 0; i < 100; i++) {
      context.recordTurn(i % 2 === 0 ? 'interviewer' : 'candidate', `A fairly long turn ${i}. `.repeat(30))
    }
    const messages = context.buildMessages('what is your favourite database', CONFIG)
    expect(context.estimateTokens(messages)).toBeLessThan(2500)
  })

  it('sends only the recent window verbatim', () => {
    const context = new ContextManager()
    for (let i = 0; i < 30; i++) context.recordTurn('interviewer', `unique-marker-${i}`)
    const joined = context
      .buildMessages('q', CONFIG)
      .map((m) => m.content)
      .join('\n')
    expect(joined).toContain('unique-marker-29')
    expect(joined).not.toContain('unique-marker-0')
  })

  it('marks stable blocks cacheable and the question not', () => {
    const context = new ContextManager()
    context.setProfile(PROFILE)
    const messages = context.buildMessages('what is a closure', CONFIG)
    const cacheable = messages.filter((m) => m.cacheable)
    expect(cacheable.length).toBeGreaterThanOrEqual(2)
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'what is a closure' })
  })

  it('varies the instructions with interview mode', () => {
    const context = new ContextManager()
    const technical = context.buildMessages('q', { ...CONFIG, mode: 'system-design' })[0]?.content
    const behavioral = context.buildMessages('q', { ...CONFIG, mode: 'behavioral' })[0]?.content
    expect(technical).toContain('system-design')
    expect(behavioral).toContain('behavioral')
    expect(technical).not.toBe(behavioral)
  })
})

describe('rolling summary', () => {
  it('does nothing until there is a real backlog', async () => {
    const context = new ContextManager()
    const llm = new SummaryLLM()
    context.recordTurn('interviewer', 'hello')
    await context.maybeSummarize(llm, 'm')
    expect(llm.calls).toHaveLength(0)
  })

  it('folds older turns into a summary once the backlog is large enough', async () => {
    const context = new ContextManager()
    const llm = new SummaryLLM()
    for (let i = 0; i < 20; i++) context.recordTurn(i % 2 === 0 ? 'interviewer' : 'candidate', `turn ${i}`)

    await context.maybeSummarize(llm, 'm')
    expect(llm.calls).toHaveLength(1)

    const joined = context
      .buildMessages('q', CONFIG)
      .map((m) => m.content)
      .join('\n')
    expect(joined).toContain('Discussed MongoDB')
  })

  it('survives a summarizer failure without breaking the pipeline', async () => {
    const context = new ContextManager()
    const broken: LLMProvider = {
      name: 'broken',
      defaultModel: 'm',
      capabilities: { streaming: true, promptCaching: false, maxContextTokens: 100 },
      validate: () => {},
      prewarm: async () => {},
      async *stream() {
        yield { type: 'error', message: 'nope', retryable: false }
      },
    }
    for (let i = 0; i < 20; i++) context.recordTurn('interviewer', `turn ${i}`)

    // A stale summary is vastly better than a blocked answer path.
    await expect(context.maybeSummarize(broken, 'm')).resolves.toBeUndefined()
    expect(context.buildMessages('q', CONFIG).length).toBeGreaterThan(0)
  })
})

describe('memory lifecycle', () => {
  it('clear wipes the conversation but keeps the profile', () => {
    const context = new ContextManager()
    context.setProfile(PROFILE)
    context.recordTurn('interviewer', 'something')
    context.clear()
    expect(context.turnCount).toBe(0)
    expect(context.buildMessages('q', CONFIG).some((m) => m.content.includes('Alok'))).toBe(true)
  })

  it('reviseLastTurn replaces rather than appends', () => {
    const context = new ContextManager()
    context.recordTurn('interviewer', 'first version')
    context.reviseLastTurn('interviewer', 'corrected version')
    expect(context.turnCount).toBe(1)
    const joined = context
      .buildMessages('q', CONFIG)
      .map((m) => m.content)
      .join('\n')
    expect(joined).toContain('corrected version')
    expect(joined).not.toContain('first version')
  })
})
