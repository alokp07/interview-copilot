/**
 * Interview memory and prompt construction.
 *
 * Two competing pressures shape this file. The model needs enough context to
 * avoid contradicting the candidate ("you said you used Postgres earlier"), but
 * every token in the prompt costs both money and prompt-processing time on the
 * critical path. So we never send the raw transcript. Instead:
 *
 *   stable candidate card  (built once, marked cacheable)
 * + rolling summary        (refreshed off the critical path by a cheap model)
 * + last N turns verbatim  (where contradictions actually happen)
 * + the current question
 *
 * Target: under ~1200 tokens regardless of how long the interview runs.
 */

import { createLogger } from '@main/core/logger'
import type { LLMMessage, LLMProvider } from '@main/contracts/llm'
import type {
  CandidateProfile,
  InterviewMode,
  SessionConfig,
  Speaker,
} from '@shared/types'

const log = createLogger('context')

/** Turns kept verbatim. Beyond this, content is folded into the summary. */
const VERBATIM_TURNS = 6
/** Fold into the summary once the backlog passes this. */
const SUMMARIZE_AFTER = 10
/** Hard cap on any single profile field, so a pasted resume can't dominate. */
const FIELD_CHAR_CAP = 1200

export interface ConversationTurn {
  speaker: Speaker
  text: string
  at: number
}

const LENGTH_RULES: Record<SessionConfig['answerLength'], string> = {
  brief: 'Keep it to 25-45 words. One tight paragraph.',
  normal: 'Keep it to 45-90 words. One paragraph, maybe two short ones.',
  detailed: 'Keep it to 90-160 words. Two short paragraphs at most.',
}

const MODE_GUIDANCE: Record<InterviewMode, string> = {
  general:
    'Match the shape of the question: concept questions get a definition then a short example; story questions get a first-person story.',
  technical:
    'Lead with the direct answer in one sentence, then why it matters, then a concrete example from your own work.',
  behavioral:
    'Tell it as a short first-person story: the situation, what you personally did, how it turned out. Never name a framework like STAR out loud.',
  'system-design':
    'Structure it: clarify the requirement in one line, name the core components and how data flows between them, then scaling and one honest tradeoff. Short lines, not prose.',
  coding:
    'State the approach in one or two sentences first, then the key code or algorithm, then time and space complexity. Think out loud like a candidate at a whiteboard.',
  hr: 'Warm, concise, honest. No corporate filler. Show motivation and fit without overselling.',
}

export class ContextManager {
  private profile: CandidateProfile | null = null
  private profileCard = ''
  private keyterms: string[] = []
  private turns: ConversationTurn[] = []
  private summary = ''
  /** Turns already folded into `summary`. */
  private summarizedCount = 0
  private summarizing = false

  setProfile(profile: CandidateProfile): void {
    this.profile = profile
    this.profileCard = buildProfileCard(profile)
    this.keyterms = extractKeyterms(profile)
    log.info('profile updated', {
      cardChars: this.profileCard.length,
      keyterms: this.keyterms.length,
    })
  }

  getProfile(): CandidateProfile | null {
    return this.profile
  }

  /**
   * Domain terms fed to the recognizer so it spells the candidate's stack
   * correctly — "Pinecone" and "Kubernetes" are exactly the words a generic
   * model mangles, and a mangled question produces a wrong answer.
   */
  getKeyterms(): string[] {
    return this.keyterms
  }

  recordTurn(speaker: Speaker, text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    this.turns.push({ speaker, text: trimmed, at: Date.now() })
  }

  /** Replaces the last recorded turn from a speaker — used when a turn is revised. */
  reviseLastTurn(speaker: Speaker, text: string): void {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i]?.speaker === speaker) {
        this.turns[i] = { speaker, text: text.trim(), at: this.turns[i]!.at }
        return
      }
    }
    this.recordTurn(speaker, text)
  }

  clear(): void {
    this.turns = []
    this.summary = ''
    this.summarizedCount = 0
  }

  get turnCount(): number {
    return this.turns.length
  }

  private recentTurns(): ConversationTurn[] {
    return this.turns.slice(-VERBATIM_TURNS)
  }

  buildMessages(question: string, config: SessionConfig): LLMMessage[] {
    const messages: LLMMessage[] = []

    // --- Stable block: identical for the whole session, so it is cacheable ---
    const system = [
      'You are a live interview copilot. Output ONLY the words the candidate should say out loud, as the candidate.',
      '',
      'Hard rules:',
      '- First person, spoken English, natural contractions. Easy to say out loud.',
      '- No preamble. Never start with "Great question", "Certainly", "Sure", or by restating the question.',
      '- No markdown headings, no bold, no bullet characters unless you are listing concrete steps.',
      `- ${LENGTH_RULES[config.answerLength]}`,
      '- Never invent specific employers, dates, metrics, or product names that are not in the candidate profile. If the profile is thin, answer from general expertise in a way that stays true for this candidate.',
      '- If the question is ambiguous, answer the most likely reading. Never ask for clarification.',
      '- Do not mention that you are an AI or that the candidate is being assisted.',
      '',
      `Interview mode: ${config.mode}. ${MODE_GUIDANCE[config.mode]}`,
    ].join('\n')

    messages.push({ role: 'system', content: system, cacheable: true })

    if (this.profileCard) {
      messages.push({
        role: 'system',
        content: `Candidate profile:\n${this.profileCard}`,
        cacheable: true,
      })
    }

    // --- Volatile block: cheap to re-send, changes every turn ---------------
    if (this.summary) {
      messages.push({
        role: 'system',
        content: `Earlier in this interview:\n${this.summary}`,
      })
    }

    const recent = this.recentTurns()
    if (recent.length > 0) {
      const lines = recent
        .map((t) => `${t.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}: ${t.text}`)
        .join('\n')
      messages.push({
        role: 'system',
        content: `Recent exchange (do not contradict anything the candidate already said):\n${lines}`,
      })
    }

    messages.push({ role: 'user', content: question })
    return messages
  }

  /** Rough token estimate for the budget readout — chars/4 is close enough. */
  estimateTokens(messages: LLMMessage[]): number {
    return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4)
  }

  /**
   * Folds older turns into the rolling summary. Runs *after* an answer has been
   * delivered, never before one, so it can never delay a response. Failure is
   * non-fatal: a stale summary is much better than a blocked pipeline.
   */
  async maybeSummarize(provider: LLMProvider, model: string): Promise<void> {
    const backlog = this.turns.length - this.summarizedCount
    if (this.summarizing || backlog < SUMMARIZE_AFTER) return

    const upTo = this.turns.length - VERBATIM_TURNS
    if (upTo <= this.summarizedCount) return

    this.summarizing = true
    const slice = this.turns.slice(this.summarizedCount, upTo)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)

    try {
      const transcript = slice
        .map((t) => `${t.speaker === 'interviewer' ? 'Q' : 'A'}: ${t.text}`)
        .join('\n')

      const messages: LLMMessage[] = [
        {
          role: 'system',
          content:
            'Compress this interview excerpt into terse notes for later reference. ' +
            'Capture: topics covered, technologies and projects the candidate claimed, ' +
            'specific facts or numbers they stated, and anything the interviewer emphasised. ' +
            'Max 80 words. No preamble, no headings — just the notes.',
        },
        {
          role: 'user',
          content: this.summary
            ? `Existing notes:\n${this.summary}\n\nNew excerpt:\n${transcript}`
            : transcript,
        },
      ]

      let out = ''
      for await (const event of provider.stream({
        messages,
        model,
        maxTokens: 200,
        temperature: 0.2,
        signal: controller.signal,
      })) {
        if (event.type === 'delta' && event.text) out += event.text
        if (event.type === 'error') throw new Error(event.message ?? 'summary failed')
      }

      if (out.trim()) {
        this.summary = out.trim()
        this.summarizedCount = upTo
        log.debug('summary refreshed', { chars: this.summary.length, upTo })
      }
    } catch (err) {
      log.warn('summarization failed; continuing with the previous summary', err)
    } finally {
      clearTimeout(timeout)
      this.summarizing = false
    }
  }
}

// ---------------------------------------------------------------------------
// Profile compaction
// ---------------------------------------------------------------------------

function clip(value: string, cap = FIELD_CHAR_CAP): string {
  const clean = value.trim().replace(/\s+/g, ' ')
  return clean.length <= cap ? clean : `${clean.slice(0, cap)}…`
}

/**
 * Turns the profile form into a compact card. A pasted resume is the big risk
 * here — it can be thousands of tokens — so it is clipped hard and placed last.
 */
export function buildProfileCard(profile: CandidateProfile): string {
  const parts: string[] = []
  const add = (label: string, value: string, cap?: number): void => {
    const v = clip(value, cap)
    if (v) parts.push(`${label}: ${v}`)
  }

  add('Name', profile.name, 80)
  add('Role', profile.role, 120)
  add('Experience', profile.yearsExperience, 60)
  add('Skills', profile.skills, 400)
  add('Projects', profile.projects, 700)
  add('Target company', profile.company, 120)
  add('Job description', profile.jobDescription, 900)
  add('Notes', profile.notes, 400)
  add('Resume', profile.resume, FIELD_CHAR_CAP)

  return parts.join('\n')
}

/**
 * Pulls likely proper nouns and tech terms out of the profile to bias the
 * recognizer. Deepgram accepts a bounded list, so we cap it.
 */
export function extractKeyterms(profile: CandidateProfile, limit = 40): string[] {
  const source = [profile.skills, profile.projects, profile.company, profile.role].join(' , ')
  const seen = new Set<string>()
  const out: string[] = []

  for (const raw of source.split(/[,;/|\n]+/)) {
    const term = raw.trim().replace(/^[-•*\s]+/, '')
    if (!term) continue
    const words = term.split(/\s+/)
    // Single words and short phrases make good keyterms; sentences do not.
    if (words.length > 3 || term.length < 2 || term.length > 40) continue
    if (/^(and|or|the|with|using|for|in|on|of|a|an)$/i.test(term)) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(term)
    if (out.length >= limit) break
  }
  return out
}
