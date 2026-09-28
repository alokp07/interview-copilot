import { describe, expect, it } from 'vitest'
import {
  classify,
  classifyType,
  extractLatestQuestion,
  normalizeQuestion,
  similarity,
} from '@main/interview/question-gate'

describe('question detection', () => {
  it('detects wh-questions without punctuation', () => {
    // Speech transcription frequently omits the question mark, so the classifier
    // must never depend on it.
    for (const text of [
      'why did you choose mongodb for that project',
      'what happens during react reconciliation',
      'how would you scale that to a million users',
      'when did you start working with python',
    ]) {
      const result = classify(text)
      expect(result.isQuestion, text).toBe(true)
      expect(result.confidence, text).toBe('high')
    }
  })

  it('detects auxiliary-initial yes/no questions', () => {
    for (const text of [
      'can you explain how the event loop works',
      'have you worked with kubernetes before',
      'did you write the tests for that yourself',
    ]) {
      expect(classify(text).isQuestion, text).toBe(true)
    }
  })

  it('detects imperative prompts that are grammatically statements', () => {
    for (const text of [
      'tell me about yourself',
      'walk me through your last project',
      'describe a time you disagreed with a teammate',
      "let's talk about your experience with distributed systems",
    ]) {
      const result = classify(text)
      expect(result.isQuestion, text).toBe(true)
    }
  })

  it('detects system-design scenario setups', () => {
    for (const text of [
      "let's say we have a system that ingests a million events a second",
      'suppose you need to design a url shortener',
      'imagine the database goes down mid-write',
    ]) {
      expect(classify(text).isQuestion, text).toBe(true)
    }
  })

  it('stays silent on acknowledgements', () => {
    for (const text of [
      'okay',
      'got it',
      'makes sense',
      'mm hmm',
      'right',
      'perfect thanks',
      'yeah',
      'interesting',
    ]) {
      const result = classify(text)
      expect(result.isQuestion, `"${text}" should not trigger an answer`).toBe(false)
      expect(result.reason).toBe('acknowledgement')
    }
  })

  it('stays silent on meeting logistics even though they are questions', () => {
    // These are grammatically questions; answering them with interview content
    // would be worse than saying nothing.
    for (const text of [
      'can you hear me okay',
      'can you see my screen',
      "you're on mute",
      'could you repeat that',
      'let me share my screen',
    ]) {
      const result = classify(text)
      expect(result.isQuestion, `"${text}" should be ignored`).toBe(false)
      expect(result.reason).toBe('meeting-logistics')
    }
  })

  it('stays silent on greetings and closings', () => {
    for (const text of ['good morning', 'nice to meet you', "let's get started", 'that’s all']) {
      expect(classify(text).isQuestion, text).toBe(false)
    }
  })

  it('detects elliptical follow-up questions', () => {
    // Regression: "So any other methods to enhance" was silently dropped during
    // a live interview test — no wh-word, no auxiliary, no question mark, and
    // one word short of the substantial-utterance fallback.
    for (const text of [
      'so any other methods to enhance',
      'any other methods to improve performance',
      'anything else you would add',
      'any thoughts on that',
      'what about scaling',
      'how about testing',
      'any experience with kubernetes',
      'such as',
    ]) {
      expect(classify(text).isQuestion, `"${text}" should be answered`).toBe(true)
    }
  })

  it('does not mistake acknowledgements for follow-ups', () => {
    // "any"-initial matching must not swallow the backchannel list.
    for (const text of ['no', 'nope', 'okay', 'got it', 'perfect thanks']) {
      expect(classify(text).isQuestion, text).toBe(false)
    }
  })

  it('answers ambiguous long utterances rather than risk missing a question', () => {
    // Latency-first policy: a missed question is a product failure, a spurious
    // answer is ignorable.
    const result = classify('so the role involves a lot of backend work on our payments platform')
    expect(result.isQuestion).toBe(true)
    expect(result.confidence).toBe('low')
    expect(result.reason).toBe('substantial-utterance')
  })

  it('ignores short fragments with no question signal', () => {
    expect(classify('the thing').isQuestion).toBe(false)
    expect(classify('').isQuestion).toBe(false)
  })
})

describe('self-correction handling', () => {
  it('keeps only the question after the last correction marker', () => {
    const raw = 'why did you use mongodb — actually, before that, tell me about your team'
    expect(extractLatestQuestion(raw)).toBe('tell me about your team')
  })

  it('handles a mid-sentence restart', () => {
    const raw = 'how do you handle state, sorry, let me rephrase, what state library do you prefer'
    expect(extractLatestQuestion(raw)).toBe('what state library do you prefer')
  })

  it('does not strip when the tail is too short to stand alone', () => {
    const raw = 'why did you pick mongodb actually'
    expect(extractLatestQuestion(raw)).toBe('why did you pick mongodb actually')
  })

  it('strips leading discourse filler', () => {
    expect(extractLatestQuestion('so um, why did you choose react')).toBe(
      'why did you choose react'
    )
  })

  it('never strips an utterance down to nothing', () => {
    expect(extractLatestQuestion('so yeah well').length).toBeGreaterThan(0)
  })

  it('classifies the corrected question, not the abandoned one', () => {
    const result = classify('why mongodb — actually, scratch that, walk me through your testing setup')
    expect(result.isQuestion).toBe(true)
    expect(result.text).toContain('testing setup')
    expect(result.text).not.toContain('mongodb')
  })
})

describe('similarity', () => {
  it('scores identical text as 1', () => {
    expect(similarity('tell me about yourself', 'Tell me about yourself!')).toBe(1)
  })

  it('scores a one-word tail change as high (promotable speculation)', () => {
    const eager = 'why did you choose mongodb for that'
    const final = 'why did you choose mongodb for that project'
    expect(similarity(eager, final)).toBeGreaterThanOrEqual(0.85)
  })

  it('scores a changed question as low (must regenerate)', () => {
    const eager = 'why did you choose mongodb'
    const final = 'tell me about your experience leading a team'
    expect(similarity(eager, final)).toBeLessThan(0.3)
  })

  it('normalizes punctuation and case', () => {
    expect(normalizeQuestion('Why  MongoDB??')).toBe('why mongodb')
  })
})

describe('question-type detection', () => {
  const cases: Array<[string, ReturnType<typeof classifyType>]> = [
    ['write a function that reverses a string', 'coding'],
    ['reverse a linked list and give the time complexity', 'coding'],
    ['design a system that handles millions of requests', 'system-design'],
    ['how would you design a scalable notification service', 'system-design'],
    ['tell me about a time you disagreed with a teammate', 'behavioral'],
    ['how did you handle a difficult stakeholder', 'behavioral'],
    ['why do you want to work here', 'hr'],
    ['what is your greatest weakness', 'hr'],
    ['what is the difference between a process and a thread', 'technical'],
    ['how does the event loop work', 'technical'],
  ]

  for (const [text, expected] of cases) {
    it(`classifies "${text}" as ${expected}`, () => {
      expect(classifyType(text)).toBe(expected)
    })
  }

  it('falls back to general when nothing specific fits', () => {
    expect(classifyType('so, anything else on that')).toBe('general')
  })

  it('exposes the detected type on the gate result', () => {
    expect(classify('write a function to sort an array').type).toBe('coding')
  })
})
