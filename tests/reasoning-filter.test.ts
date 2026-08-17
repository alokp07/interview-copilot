/**
 * Some models (Qwen 3 among them) emit their scratchpad inline in `content`
 * rather than a separate field. Unfiltered, the candidate watches the model
 * think instead of reading their answer — observed live during benchmarking.
 */

import { describe, expect, it } from 'vitest'
import { ReasoningFilter } from '@main/providers/llm/openai-compatible'
import { modelParams } from '@shared/models'

function run(chunks: string[]): string {
  const filter = new ReasoningFilter()
  let out = ''
  for (const chunk of chunks) out += filter.push(chunk)
  return out + filter.flush()
}

describe('ReasoningFilter', () => {
  it('passes ordinary text through untouched', () => {
    expect(run(['I chose ', 'MongoDB ', 'because…'])).toBe('I chose MongoDB because…')
  })

  it('removes a complete think block', () => {
    expect(run(['<think>plan the answer</think>The real answer.'])).toBe('The real answer.')
  })

  it('removes a think block split across chunks', () => {
    expect(run(['<thi', 'nk>step one', ' step two</thi', 'nk>Answer here'])).toBe('Answer here')
  })

  it('holds back a partial opening tag rather than leaking it', () => {
    const filter = new ReasoningFilter()
    // "<th" could still become "<think>", so it must not be emitted yet.
    expect(filter.push('Answer<th')).toBe('Answer')
    expect(filter.push('ink>hidden</think> more')).toBe(' more')
  })

  it('emits a held-back fragment that turns out not to be a tag', () => {
    const filter = new ReasoningFilter()
    expect(filter.push('a < b')).toBe('a < b')
    expect(filter.flush()).toBe('')
  })

  it('emits text preceding a think block', () => {
    expect(run(['Sure. <think>hmm</think>Done.'])).toBe('Sure. Done.')
  })

  it('drops an unterminated think block entirely', () => {
    // Truncated mid-reasoning: better to show nothing than raw scratchpad.
    expect(run(['<think>I should consider'])).toBe('')
  })

  it('handles multiple think blocks', () => {
    expect(run(['<think>a</think>One <think>b</think>Two'])).toBe('One Two')
  })

  it('does not swallow a lone angle bracket at the end', () => {
    expect(run(['5 > 3 and 2 < 4'])).toBe('5 > 3 and 2 < 4')
  })
})

describe('model parameters', () => {
  it('forces low reasoning effort for the gpt-oss family', () => {
    // Not cosmetic: at default effort gpt-oss-20b spent its entire token budget
    // on hidden reasoning and returned a truncated six-word answer.
    expect(modelParams('openai/gpt-oss-20b')).toEqual({ reasoning_effort: 'low' })
    expect(modelParams('openai/gpt-oss-120b')).toEqual({ reasoning_effort: 'low' })
  })

  it('leaves other models alone', () => {
    expect(modelParams('claude-haiku-4-5')).toEqual({})
    expect(modelParams('gpt-4o-mini')).toEqual({})
  })
})
