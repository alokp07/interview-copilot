/**
 * The resume extractor treats the model's output as hostile input: fenced,
 * chatty, truncated or wrong-shaped JSON must degrade to "no fields", never to
 * a crash or to garbage silently written into the profile.
 */

import { describe, expect, it } from 'vitest'
import { extractJsonObject, parseResume } from '@main/interview/resume-parser'
import type { LLMProvider, LLMRequest, LLMStreamEvent } from '@main/contracts/llm'

function providerReturning(chunks: string[], fail = false): LLMProvider {
  return {
    name: 'scripted',
    defaultModel: 'm',
    capabilities: { streaming: true, promptCaching: false, maxContextTokens: 8000 },
    validate: () => {},
    prewarm: async () => {},
    async *stream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      void _request
      if (fail) {
        yield { type: 'error', message: 'provider down', retryable: false }
        return
      }
      for (const chunk of chunks) yield { type: 'delta', text: chunk }
      yield { type: 'done' }
    },
  }
}

const RESUME = 'Alok — Full-stack engineer. React, Node.js. B.Tech 2024.'

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"name":"Alok"}')).toEqual({ name: 'Alok' })
  })

  it('digs the object out of code fences and chatter', () => {
    const raw = 'Sure, here is the JSON:\n```json\n{"skills":"React, Node.js"}\n```\nHope that helps!'
    expect(extractJsonObject(raw)).toEqual({ skills: 'React, Node.js' })
  })

  it('returns null for garbage, truncation, and non-objects', () => {
    expect(extractJsonObject('no json here')).toBeNull()
    expect(extractJsonObject('{"name": "Al')).toBeNull()
    expect(extractJsonObject('[1,2,3]')).toBeNull()
  })
})

describe('parseResume', () => {
  it('extracts known fields and trims them', async () => {
    const provider = providerReturning([
      '{"name":" Alok ","skills":"React, Node.js",',
      '"education":"B.Tech CSE, 2024","workExperience":"Acme — dev"}',
    ])
    const fields = await parseResume(RESUME, provider, 'm')
    expect(fields).toEqual({
      name: 'Alok',
      skills: 'React, Node.js',
      education: 'B.Tech CSE, 2024',
      workExperience: 'Acme — dev',
    })
  })

  it('drops unknown keys, empty strings, and non-string values', () => {
    const provider = providerReturning([
      // `company` is deliberately not extractable (a resume cannot know the
      // target company), and hallucinated shapes must not leak through.
      '{"skills":"React","company":"Evil Corp","yearsExperience":3,"projects":"  ","hacked":true}',
    ])
    return parseResume(RESUME, provider, 'm').then((fields) => {
      expect(fields).toEqual({ skills: 'React' })
    })
  })

  it('returns empty for unparseable output instead of throwing', async () => {
    const provider = providerReturning(['I could not find structured data, sorry!'])
    await expect(parseResume(RESUME, provider, 'm')).resolves.toEqual({})
  })

  it('propagates provider failure so the UI can show a real error', async () => {
    const provider = providerReturning([], true)
    await expect(parseResume(RESUME, provider, 'm')).rejects.toThrow('provider down')
  })
})
