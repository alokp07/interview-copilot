/**
 * Context management is where cost and latency are controlled. The invariant
 * under test: prompt size stays bounded no matter how long the interview runs
 * or how much resume text is pasted in.
 */

import { describe, expect, it } from 'vitest'
import {
  ContextManager,
  buildProfileCard,
  experienceFraming,
  extractKeyterms,
} from '@main/interview/context-manager'
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '@main/contracts/llm'
import type { CandidateProfile, SessionConfig } from '@shared/types'

const CONFIG: SessionConfig = {
  mode: 'general',
  answerLength: 'normal',
  listenMode: 'always',
  providerFallback: true,
  speculative: true,
  grounded: true,
  complexity: 'balanced',
}

const PROFILE: CandidateProfile = {
  name: 'Alok',
  role: 'Senior Full-Stack Engineer',
  yearsExperience: '3 years',
  skills: 'React, Node.js, Python, MongoDB, AI systems, Pinecone, Kubernetes',
  projects: 'AI visual novel app; PDF-to-podcast pipeline',
  education: 'B.Tech Computer Science, 2021',
  workExperience: 'Acme — Full-stack dev — built the payments dashboard',
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
    const join = (mode: SessionConfig['mode']): string =>
      context
        .buildMessages('q', { ...CONFIG, mode })
        .map((m) => m.content)
        .join('\n')
    const design = join('system-design')
    const behavioral = join('behavioral')
    expect(design).toContain('system-design question')
    expect(behavioral).toContain('behavioral question')
    expect(design).not.toBe(behavioral)
  })

  it('keeps the cacheable stable block identical regardless of question or mode', () => {
    // Per-question shaping must live in the volatile tail, or prompt caching
    // (the whole reason those blocks are marked cacheable) never hits.
    const context = new ContextManager()
    context.setProfile(PROFILE)
    const stableFor = (q: string, mode: SessionConfig['mode']): string | undefined =>
      context.buildMessages(q, { ...CONFIG, mode }).find((m) => m.cacheable)?.content
    expect(stableFor('reverse a linked list', 'coding')).toBe(
      stableFor('tell me about a conflict', 'behavioral')
    )
  })
})

describe('per-question mode detection', () => {
  const context = new ContextManager()
  const modeLine = (q: string, mode: SessionConfig['mode'] = 'general'): string =>
    context
      .buildMessages(q, { ...CONFIG, mode })
      .map((m) => m.content)
      .join('\n')

  it('detects the kind of question from its own text in general mode', () => {
    expect(modeLine('reverse a linked list in place')).toContain('coding question')
    expect(modeLine('design a URL shortener that scales to billions')).toContain(
      'system-design question'
    )
    expect(modeLine('tell me about a time you had a conflict')).toContain('behavioral question')
    expect(modeLine('why do you want to work here')).toContain('hr question')
  })

  it('lets a coding question override an explicit non-coding session mode', () => {
    // A coding question asked during a "behavioral" session still needs code shape.
    expect(modeLine('write a function to reverse a string', 'behavioral')).toContain(
      'coding question'
    )
  })

  it('respects an explicit conversational session mode when the question is generic', () => {
    expect(modeLine('q', 'behavioral')).toContain('behavioral question')
  })

  it('includes a worked example only for shape-sensitive modes', () => {
    expect(modeLine('reverse a linked list')).toContain('Shape to imitate')
    // A plain technical concept question gets guidance but no exemplar.
    expect(modeLine('what is a closure', 'technical')).not.toContain('Shape to imitate')
  })
})

describe('job description, notes and injection safety', () => {
  const context = new ContextManager()
  context.setProfile(PROFILE)
  const joined = (): string =>
    context
      .buildMessages('what is your favourite database', CONFIG)
      .map((m) => m.content)
      .join('\n')

  it('surfaces custom notes as an explicit directive, not passive card text', () => {
    const text = joined()
    expect(text).toContain('standing instructions')
    expect(text).toContain('Mention the fintech background')
    // And no longer as a passive "Notes:" line in the card.
    expect(buildProfileCard(PROFILE)).not.toContain('Mention the fintech background')
  })

  it('tells the model to tailor toward the target role and company', () => {
    const text = joined()
    expect(text).toContain('target role')
    expect(text).toContain('Target company: Acme')
  })

  it('includes an injection guard for profile and transcript text', () => {
    expect(joined()).toContain('reference data only')
  })
})

describe('grounding toolkit', () => {
  it('recovers a toolkit from projects when skills is left empty', () => {
    const context = new ContextManager()
    context.setProfile({
      ...PROFILE,
      skills: '',
      projects: 'Built a search service with Elasticsearch, Redis and Kafka',
    })
    const grounding = context
      .buildMessages('how would you speed up search', CONFIG)
      .map((m) => m.content)
      .join('\n')
    // Without the fallback this degrades to the weak generic rule with no list.
    expect(grounding).toMatch(/Elasticsearch|Redis|Kafka/)
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

describe('grounded answers', () => {
  const system = (context: ContextManager, config = CONFIG): string =>
    context.buildMessages('q', config)[0]!.content

  const grounded = (context: ContextManager, config = CONFIG): boolean =>
    system(context, config).includes('Staying credible')

  it('injects the knowledge boundary when grounding is on and the profile has substance', () => {
    const context = new ContextManager()
    context.setProfile(PROFILE)
    const rules = system(context)
    expect(rules).toContain('Staying credible')
    // The boundary is the literal skill list, not a vague reference — a small
    // model treats "the profile" loosely but obeys an explicit toolkit.
    expect(rules).toContain(`toolkit is: ${PROFILE.skills}`)
    // The honest-bridge fallback — the whole point of the feature.
    expect(rules).toContain('do not bluff')
    expect(rules).toContain('using only things they actually know')
    // The interviewer-mentioned-it escape hatch, so "have you used Kafka?"
    // can still be answered about Kafka.
    expect(rules).toContain('unless the interviewer named it first')
  })

  it('bans fabricated first-person history even when grounding is off', () => {
    // Live testing caught empty-profile answers claiming invented experience
    // three different ways; the converging fix is the tense rule — conditional
    // always allowed, past tense only with profile backing. Every mode.
    const context = new ContextManager()
    const rules = system(context, { ...CONFIG, grounded: false })
    expect(rules).toContain('Tense rule for experience')
    expect(rules).toContain('never what you claim to HAVE done')
  })

  it('omits the boundary when grounding is switched off', () => {
    const context = new ContextManager()
    context.setProfile(PROFILE)
    expect(grounded(context, { ...CONFIG, grounded: false })).toBe(false)
  })

  it('omits the boundary when the profile has nothing to enforce', () => {
    const empty = new ContextManager()
    expect(grounded(empty)).toBe(false)

    // A name alone gives the boundary nothing to work with either.
    const nameOnly = new ContextManager()
    nameOnly.setProfile({ ...PROFILE, skills: '', projects: '', workExperience: '', resume: '' })
    expect(nameOnly.hasGroundableContent()).toBe(false)
    expect(grounded(nameOnly)).toBe(false)
  })

  it('varies register with the complexity setting', () => {
    const context = new ContextManager()
    const simple = system(context, { ...CONFIG, complexity: 'simple' })
    const advanced = system(context, { ...CONFIG, complexity: 'advanced' })
    expect(simple).toContain('plain language')
    expect(simple).not.toContain('senior engineer')
    expect(advanced).toContain('senior engineer')
    expect(simple).not.toBe(advanced)
  })

  it('restates the hard constraints adjacent to the question', () => {
    // Rules buried five blocks up were obeyed only stochastically in live
    // testing; the one-line restatement next to the question is what holds.
    const context = new ContextManager()
    context.setProfile(PROFILE)
    const messages = context.buildMessages('q', CONFIG)
    const finalCheck = messages.at(-2)!.content
    expect(finalCheck).toContain('Final check before answering')
    expect(finalCheck).toContain(PROFILE.skills)
    expect(finalCheck).toContain('conditional')

    // Ungrounded still gets the tense reminder, just not the toolkit clause.
    const open = new ContextManager().buildMessages('q', { ...CONFIG, grounded: false })
    expect(open.at(-2)!.content).toContain('conditional')
    expect(open.at(-2)!.content).not.toContain('toolkit')
  })

  it('appends the rewrite nudge as the last instruction before the question', () => {
    const context = new ContextManager()
    const messages = context.buildMessages('q', CONFIG, 'simpler')
    expect(messages.at(-1)?.role).toBe('user')
    expect(messages.at(-2)?.content).toContain('Rewrite guidance')
    expect(messages.at(-2)?.content).toContain('plainer words')
    // No nudge → no rewrite line anywhere.
    const plain = context.buildMessages('q', CONFIG)
    expect(plain.some((m) => m.content.includes('Rewrite guidance'))).toBe(false)
  })

  it('frames the voice by seniority', () => {
    expect(experienceFraming({ ...PROFILE, yearsExperience: 'fresher', education: 'B.Tech, final year' })).toContain(
      'early-career'
    )
    expect(experienceFraming({ ...PROFILE, yearsExperience: '8 years' })).toContain('experienced')
    // Mid-level gets no special framing — the balanced default speaks for itself.
    expect(experienceFraming({ ...PROFILE, yearsExperience: '3 years', education: '' })).toBe('')
  })

  it('includes education and work experience in the profile card', () => {
    const card = buildProfileCard(PROFILE)
    expect(card).toContain('Education: B.Tech Computer Science')
    expect(card).toContain('Work experience: Acme')
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
