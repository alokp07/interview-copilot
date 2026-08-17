/**
 * Resume → profile-field extraction.
 *
 * Runs entirely off the answer path (user clicks a button in the Profile tab),
 * so it can afford a full non-streaming generation. The provider is injected
 * rather than resolved here so tests can drive it with a scripted LLM.
 *
 * The model's output is treated as hostile input: fenced, chatty, or truncated
 * JSON must degrade to "no fields extracted", never to a crash or to garbage
 * silently written into the profile.
 */

import { createLogger } from '@main/core/logger'
import type { LLMProvider } from '@main/contracts/llm'
import type { CandidateProfile } from '@shared/types'

const log = createLogger('resume-parser')

/** Fields the extractor may fill. Target company is deliberately absent — a resume can't know it. */
const EXTRACTABLE = [
  'name',
  'role',
  'yearsExperience',
  'skills',
  'projects',
  'education',
  'workExperience',
] as const satisfies ReadonlyArray<keyof CandidateProfile>

type Extractable = (typeof EXTRACTABLE)[number]

const EXTRACTION_PROMPT = [
  'Extract structured facts from the resume below. Respond with ONLY a JSON object — no prose, no code fences.',
  'Keys (all values are plain strings; omit a key when the resume gives nothing for it):',
  '- "name": the candidate\'s name',
  '- "role": their most recent job title, or degree-based title for students',
  '- "yearsExperience": total professional experience, e.g. "3 years" or "fresher"',
  '- "skills": comma-separated technologies and skills, most prominent first',
  '- "projects": up to 5 lines, one project per line: "Name — what it is, tech used"',
  '- "education": one line: degree, institution, year',
  '- "workExperience": up to 5 lines, one job per line: "Company — role — what they did"',
  'Only state what the resume actually says. Do not infer or embellish.',
].join('\n')

/** Pull the first JSON object out of a possibly fenced / chatty response. */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(raw.slice(start, end + 1))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export async function parseResume(
  resumeText: string,
  provider: LLMProvider,
  model: string
): Promise<Partial<CandidateProfile>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)

  try {
    let out = ''
    for await (const event of provider.stream({
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        // A resume longer than this is padding, not signal.
        { role: 'user', content: resumeText.slice(0, 12_000) },
      ],
      model,
      maxTokens: 700,
      temperature: 0,
      signal: controller.signal,
    })) {
      if (event.type === 'delta' && event.text) out += event.text
      if (event.type === 'error') throw new Error(event.message ?? 'extraction failed')
    }

    const json = extractJsonObject(out)
    if (!json) {
      log.warn('extractor returned no parseable JSON')
      return {}
    }

    const fields: Partial<CandidateProfile> = {}
    for (const key of EXTRACTABLE) {
      const value = json[key]
      if (typeof value === 'string' && value.trim()) {
        fields[key as Extractable] = value.trim()
      }
    }
    log.info('resume parsed', { fields: Object.keys(fields) })
    return fields
  } finally {
    clearTimeout(timeout)
  }
}
