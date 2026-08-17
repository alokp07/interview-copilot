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
  AnswerComplexity,
  AnswerNudge,
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

/**
 * Vocabulary/depth register. This is a *credibility* control, not a quality
 * dial: an answer pitched above the candidate's level reads as coached the
 * moment the interviewer asks "can you expand on that?".
 */
const COMPLEXITY_RULES: Record<AnswerComplexity, string> = {
  simple:
    'Use plain language and short sentences. No jargon or tool names the question itself did not use. ' +
    'Explain like a capable practitioner talking to a colleague, not an architect giving a talk. ' +
    'Prefer concrete, everyday examples over abstractions.',
  balanced:
    'Use clear, working-engineer language: technical terms where they earn their place, plain words everywhere else.',
  advanced:
    'Use precise technical vocabulary, name specific mechanisms and tradeoffs, and quantify where possible. ' +
    'Speak with the voice of a senior engineer who has shipped and maintained real systems.',
}

/**
 * The knowledge boundary. Injected only when grounding is on and the profile
 * has substance. Every rule serves one goal: the candidate must be able to
 * defend every word of the answer in a follow-up.
 *
 * The toolkit is spelled out verbatim rather than referenced ("the profile")
 * because live testing showed a small model treating the reference loosely: a
 * fresher profile of "HTML, CSS, basic JavaScript" still got Redis and sharded
 * clusters in its answer. An explicit list survives low reasoning effort.
 */
function groundingRules(profile: CandidateProfile): string {
  const stack = profile.skills.trim().replace(/\s+/g, ' ')
  return [
    'Staying credible — the candidate must be able to defend every word in follow-up questions:',
    stack
      ? `- The candidate's entire toolkit is: ${stack}. Treat every technology NOT in that list as something they have never used.`
      : '- Only claim hands-on experience the profile supports.',
    '- Never name a technology outside that toolkit unless the interviewer named it first — not even as a passing suggestion ("something like Redis").',
    '- Draw examples from the candidate’s own projects and work history; never invent employers, tools, or outcomes.',
    '- If the question is beyond their toolkit, do not bluff and do not recite an expert answer. Sound like a bright candidate reasoning out loud: admit limited hands-on exposure in one clause, state the core concept in one plain sentence, then work the problem using only things they actually know.',
  ].join('\n')
}

const NUDGE_RULES: Record<AnswerNudge, string> = {
  simpler:
    'Rewrite guidance: the previous answer was pitched too high. Use plainer words, shorter sentences, and drop any jargon the question itself did not use. Same question, humbler register.',
  deeper:
    'Rewrite guidance: add one more layer of concrete technical depth — a specific mechanism, tradeoff, or number — while staying within the same length limits.',
}

/**
 * One sentence that sets the *voice* to match the candidate's seniority, so a
 * fresher doesn't sound like a staff engineer and vice versa. Local and cheap.
 */
export function experienceFraming(profile: CandidateProfile): string {
  const haystack = `${profile.yearsExperience} ${profile.education} ${profile.role}`.toLowerCase()
  const years = Number.parseFloat(profile.yearsExperience.match(/\d+(\.\d+)?/)?.[0] ?? '')
  const fresher =
    /\b(fresher|student|intern|graduate|pursuing|final year|undergrad)\b/.test(haystack) ||
    (!Number.isNaN(years) && years <= 1)

  if (fresher) {
    return (
      'Voice: early-career. Sound enthusiastic and honest about limited production experience; ' +
      'lean on personal projects and coursework rather than claiming professional depth.'
    )
  }
  if (!Number.isNaN(years) && years >= 6) {
    return 'Voice: experienced. Calm confidence of someone who has shipped and maintained real systems.'
  }
  return ''
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

  /**
   * True when the profile carries enough substance for grounding to constrain
   * anything. A name alone gives the knowledge boundary nothing to enforce.
   */
  hasGroundableContent(): boolean {
    const p = this.profile
    if (!p) return false
    return Boolean(
      p.skills.trim() || p.projects.trim() || p.workExperience.trim() || p.resume.trim()
    )
  }

  buildMessages(question: string, config: SessionConfig, nudge?: AnswerNudge): LLMMessage[] {
    const messages: LLMMessage[] = []
    const grounded = config.grounded && this.hasGroundableContent()

    // --- Stable block: identical for the whole session, so it is cacheable ---
    const system = [
      'You are a live interview copilot. Output ONLY the words the candidate should say out loud, as the candidate.',
      '',
      'Hard rules:',
      '- First person, spoken English, natural contractions. Easy to say out loud.',
      '- No preamble. Never start with "Great question", "Certainly", "Sure", or by restating the question.',
      '- No markdown headings, no bold, no bullet characters unless you are listing concrete steps.',
      `- ${LENGTH_RULES[config.answerLength]}`,
      `- ${COMPLEXITY_RULES[config.complexity]}`,
      // Applies in every mode, grounded or not. Live testing showed that a
      // blanket "don't fabricate" loses whack-a-mole: the model reworded the
      // invented experience three different ways across three runs ("my last
      // project" → "in production we" → "in a recent project we sharded…").
      // A *grammatical* rule converges where a phrase blacklist does not:
      // future/conditional is always safe, past tense requires profile backing.
      '- Tense rule for experience: describe what you WOULD do ("I\'d build…", "my approach would be…"), never what you claim to HAVE done, unless that past experience is explicitly in the candidate profile. No invented past systems, employers, teams, or metrics — general knowledge is stated as general ("a common approach is…"), not as autobiography.',
      '- If the question is ambiguous, answer the most likely reading. Never ask for clarification.',
      '- Do not mention that you are an AI or that the candidate is being assisted.',
      ...(grounded && this.profile ? ['', groundingRules(this.profile)] : []),
      '',
      `Interview mode: ${config.mode}. ${MODE_GUIDANCE[config.mode]}`,
    ].join('\n')

    messages.push({ role: 'system', content: system, cacheable: true })

    if (this.profileCard) {
      const framing = this.profile ? experienceFraming(this.profile) : ''
      messages.push({
        role: 'system',
        content:
          `Candidate profile:\n${this.profileCard}` + (framing ? `\n\n${framing}` : ''),
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

    // One-line restatement of the hard constraints, placed adjacent to the
    // question: small models weight recent tokens heavily, and live testing
    // showed rules buried five blocks up being obeyed only stochastically.
    // Costs ~25 tokens on the already-uncached tail of the prompt.
    const checks: string[] = []
    if (grounded) {
      const stack = this.profile?.skills.trim().replace(/\s+/g, ' ')
      checks.push(`stay strictly inside the toolkit${stack ? ` (${stack})` : ''} — name nothing outside it`)
    }
    checks.push(
      'past-tense experience claims only where the profile backs them, otherwise conditional ("I\'d…")'
    )
    messages.push({ role: 'system', content: `Final check before answering: ${checks.join('; ')}.` })

    // Live rewrite request ("simpler"/"deeper"). Volatile by design — it applies
    // to exactly one regeneration. The previous answer is already visible to the
    // model via the recent-exchange block above.
    if (nudge) {
      messages.push({ role: 'system', content: NUDGE_RULES[nudge] })
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
  add('Education', profile.education, 200)
  add('Skills', profile.skills, 400)
  add('Projects', profile.projects, 700)
  add('Work experience', profile.workExperience, 700)
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
