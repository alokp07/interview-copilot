/**
 * Question detection.
 *
 * This is deliberately a *local* classifier, not an LLM call. A small model
 * would cost ~115 ms and it would sit directly in front of every answer, so it
 * would push the headline latency up by more than it could ever save in
 * discarded generations. Everything here is regex and word lists, costing
 * microseconds.
 *
 * The design rule that follows from "latency is priority #1": when we are
 * *unsure*, we answer anyway and mark it low confidence. We only stay silent for
 * utterances we can positively identify as acknowledgements or meeting
 * logistics. A missed question is a product failure; a spurious answer is a bit
 * of wasted screen space the candidate ignores.
 *
 * Speech transcription has unreliable punctuation, so question marks are treated
 * as a bonus signal, never a requirement.
 */

import type { InterviewMode, QuestionConfidence } from '@shared/types'

export interface GateResult {
  isQuestion: boolean
  confidence: QuestionConfidence
  reason: string
  /** The question text after interruption/self-correction cleanup. */
  text: string
  /** Best-guess kind of question, so the answer can be shaped per-question. */
  type: InterviewMode
}

/** Wh-words and their conversational cousins. */
const INTERROGATIVE = /^(what|why|how|when|where|who|whom|whose|which)\b/i

/** Auxiliary/modal-initial yes-no questions: "can you…", "did you…". */
const AUX_INITIAL =
  /^(can|could|would|will|won't|do|does|did|didn't|is|are|am|was|were|isn't|aren't|have|has|had|haven't|should|shall|may|might|must)\b/i

/** Imperative interview prompts — grammatically statements, functionally questions. */
const IMPERATIVE_PROMPT =
  /\b(tell me|walk me through|walk us through|explain|describe|describe to me|give me|talk (?:to me )?about|talk through|share (?:with me )?|elaborate on|elaborate|run me through|take me through|show me|outline|compare|contrast)\b/i

/** Scenario setups that precede a design/coding problem. */
const SCENARIO =
  /\b(let'?s say|lets say|suppose|imagine|say (?:you|we) have|consider|assume|given that|what if|how would you|design (?:a|an)|build (?:a|an)|implement (?:a|an)|write (?:a|an)|solve)\b/i

/** Indirect questions: "I'd like to understand how…". */
const EMBEDDED =
  /\b(i'?d like to (?:know|understand|hear)|i'?m curious|curious (?:about|how|why)|wondering (?:how|why|what|if)|help me understand|tell me more)\b/i

/**
 * Elliptical follow-ups. Interviewers rarely ask a second question in full —
 * they drop into fragments that carry no wh-word, no auxiliary and (in speech)
 * no question mark, so nothing else here fires on them.
 *
 * Found in live testing: "So any other methods to enhance…" was silently
 * dropped, which is a straightforward product failure.
 */
const FOLLOW_UP =
  /^(?:any|anything|anyone)\b|\b(?:any other|any others|anything else|anything more|any thoughts|any experience|any reason|any particular)\b|^(?:what|how) about\b|^(?:such as|like what|for example|for instance|meaning|go on|and then what|anything to add)\b/i

/** Tag questions and confirmations that end an utterance. */
const TAG_QUESTION = /\b(right|correct|isn'?t it|aren'?t they|don'?t you|wouldn'?t you|yes)\s*\?+\s*$/i

/**
 * Pure acknowledgements — the main source of spurious answers in a real
 * conversation. Matched as a *run* of up to three, because interviewers stack
 * them constantly: "perfect, thanks", "ok cool", "yeah right, got it".
 */
const ACK_WORD =
  'ok(?:ay)?|k|cool|nice|great|perfect|awesome|got it|gotcha|makes sense|i see|i understand|' +
  'understood|sure|yeah|yep|yes|yup|no|nope|right|alright|all right|mm+ ?hmm+|uh ?huh|hmm+|' +
  'ah|oh|wow|interesting|very interesting|fair enough|exactly|absolutely|definitely|of course|' +
  'thank you so much|thank you|thanks|no worries|no problem|sounds good|very good|good|' +
  'excellent|amazing|brilliant|fantastic|lovely|indeed|true|correct|agreed|fine|nice one'

const ACKNOWLEDGEMENT = new RegExp(`^(?:(?:${ACK_WORD})[\\s.,!?]*){1,3}$`, 'i')

/**
 * Meeting logistics. These are real questions, but answering them with an
 * interview response would be worse than useless.
 */
const MEETING_LOGISTICS =
  /\b(can you hear me|do you hear me|are you there|can you see (?:my|the) screen|do you see (?:my|the) screen|you'?re on mute|you are on mute|i'?m on mute|am i audible|is my (?:audio|video|mic|camera) (?:ok|okay|working|fine)|let me share|i'?ll share my screen|sharing my screen|can you share your screen|(?:is|are) (?:the )?(?:audio|video|connection) (?:ok|okay|breaking|freezing)|(?:you'?re|you are) (?:breaking up|frozen|lagging)|(?:can|could) you (?:repeat|say that again)|one (?:second|sec|moment)|give me a (?:second|sec|moment)|bear with me|let me just|i'?ll be right back|sorry i was on mute)\b/i

/** Interviewer housekeeping that opens/closes an interview but needs no answer. */
const HOUSEKEEPING =
  /^(hi|hello|hey|good morning|good afternoon|good evening|welcome|nice to meet you|great to meet you|pleasure to meet you|thanks for joining|thank you for joining|let'?s get started|shall we start|we'?ll start|let'?s begin|that'?s all|that'?s it|we'?re done|we'?ll be in touch|we will be in touch|any questions for me|do you have any questions)[\s.,!?]*$/i

/**
 * Self-correction markers. Interviewers routinely restart mid-sentence:
 * "Why did you use MongoDB — actually, before that, tell me about your team."
 * Only the segment after the last marker is the live question.
 */
const CORRECTION_MARKERS =
  /\b(actually|sorry|wait|hold on|hang on|scratch that|let me rephrase|rephrase that|or rather|rather|instead|before that|first though|on second thought|never mind|nevermind|forget that|let me ask (?:you )?(?:this|something else|differently))\b/gi

const FILLER_PREFIX =
  /^(?:so|and|but|um+|uh+|er+|ah+|well|now|okay|ok|alright|right|yeah|like|i mean|you know|basically|just)\b[\s,]*/i

// ---------------------------------------------------------------------------
// Question-type detection
//
// Same philosophy as the gate: local regex, microseconds, no LLM. The point is
// to shape *this* answer (a coding question wants steps + complexity; a
// behavioral one wants a first-person story), instead of applying one session-
// wide mode to every question. Precedence runs most-specific first.
// ---------------------------------------------------------------------------

const CODING_CUES =
  /\b(write (?:a|an|some)?\s?(?:function|method|code|program|query)|implement (?:a|an)|reverse (?:a|the)|sort (?:a|an|the)|time complexity|space complexity|big[- ]?o|leetcode|algorithm|recursion|iterate|linked list|binary (?:tree|search)|hash ?map|array|substring|palindrome|fizzbuzz|two sum|traverse|pseudo ?code|edge cases?|brute force|optimi[sz]e (?:this|the|your) (?:code|solution|function))\b/i

const SYSTEM_DESIGN_CUES =
  /\b(design (?:a|an) (?:system|service|api|platform|app|feature|url|website|.*(?:system|service))|system design|scal(?:e|able|ability|ing)|high availability|load balanc|throughput|shard|partition(?:ing)?|microservices?|distributed|message queue|rate limit|caching layer|database schema|data model|consistency|replication|fault toleran|architecture|handle (?:millions|billions|\d+[mk]?\+? (?:users|requests|qps)))\b/i

const BEHAVIORAL_CUES =
  /\b(tell me about a time|describe a (?:time|situation|challenge)|give me an example of (?:a|when)|walk me through a (?:time|situation)|a time when you|how did you (?:handle|deal|approach|resolve)|conflict|disagree(?:ment|d)?|difficult (?:person|teammate|situation|coworker)|challeng(?:e|ing) (?:you|situation)|proud of|biggest (?:failure|mistake|achievement)|made a mistake|missed a deadline|under pressure|led a|leadership|mentored|feedback you)\b/i

const HR_CUES =
  /\b(why (?:do you want to|this company|should we hire|are you (?:interested|looking|leaving))|salary|compensation|expected ctc|notice period|relocat|where do you see yourself|your (?:greatest )?(?:strength|weakness)|strengths? and weakness|why are you leaving|career goals?|work[- ]life|willing to)\b/i

const TECHNICAL_CUES =
  /\b(what is|what are|how does|how do|explain|difference between|what happens when|when would you use|pros and cons|tradeoffs?|why (?:use|would you use|is|do)|define|compare)\b/i

/** Local best-guess of the question kind. Returns `general` when nothing fits. */
export function classifyType(rawText: string): InterviewMode {
  const text = extractLatestQuestion(rawText) || rawText
  if (CODING_CUES.test(text)) return 'coding'
  if (SYSTEM_DESIGN_CUES.test(text)) return 'system-design'
  if (BEHAVIORAL_CUES.test(text)) return 'behavioral'
  if (HR_CUES.test(text)) return 'hr'
  if (TECHNICAL_CUES.test(text)) return 'technical'
  return 'general'
}

export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Strips leading filler and everything before the last self-correction marker,
 * so a restarted question is judged on what the interviewer actually landed on.
 */
export function extractLatestQuestion(raw: string): string {
  let text = raw.trim()
  if (!text) return ''

  // Find the last correction marker that still leaves a usable tail.
  const markers = [...text.matchAll(CORRECTION_MARKERS)]
  for (let i = markers.length - 1; i >= 0; i--) {
    const marker = markers[i]
    if (marker?.index === undefined) continue
    // A marker at the very start is just a discourse particle, not a correction.
    if (marker.index < 3) continue
    const tail = text.slice(marker.index + marker[0].length).replace(/^[\s,.;:—-]+/, '')
    // Only accept the tail if it carries enough to be a question on its own.
    if (tail.split(/\s+/).filter(Boolean).length >= 3) {
      text = tail
      break
    }
  }

  // Peel leading filler, but never strip the utterance down to nothing.
  for (;;) {
    const stripped = text.replace(FILLER_PREFIX, '')
    if (stripped === text || stripped.split(/\s+/).filter(Boolean).length < 3) break
    text = stripped
  }

  return text.trim()
}

export function classify(rawText: string): GateResult {
  const text = extractLatestQuestion(rawText)
  const trimmed = text.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  const type = classifyType(trimmed)

  const reject = (reason: string): GateResult => ({
    isQuestion: false,
    confidence: 'low',
    reason,
    text: trimmed,
    type,
  })

  if (wordCount === 0) return reject('empty')

  // --- Positive rejections: things we are confident need no answer ----------
  if (ACKNOWLEDGEMENT.test(trimmed)) return reject('acknowledgement')
  if (HOUSEKEEPING.test(trimmed)) return reject('housekeeping')
  if (MEETING_LOGISTICS.test(trimmed)) return reject('meeting-logistics')

  // --- Positive signals ----------------------------------------------------
  // Computed before the length checks: a two-word utterance can still be a real
  // question ("such as", "like what"), so brevity alone must not veto it.
  const signals: string[] = []
  if (INTERROGATIVE.test(trimmed)) signals.push('wh-initial')
  if (AUX_INITIAL.test(trimmed)) signals.push('aux-initial')
  if (IMPERATIVE_PROMPT.test(trimmed)) signals.push('imperative-prompt')
  if (SCENARIO.test(trimmed)) signals.push('scenario')
  if (EMBEDDED.test(trimmed)) signals.push('embedded')
  if (FOLLOW_UP.test(trimmed)) signals.push('follow-up')
  if (TAG_QUESTION.test(trimmed)) signals.push('tag')
  if (trimmed.includes('?')) signals.push('question-mark')

  if (signals.length >= 2) {
    return { isQuestion: true, confidence: 'high', reason: signals.join('+'), text: trimmed, type }
  }
  if (signals.length === 1) {
    // A lone wh-word or imperative prompt with enough substance is a question.
    const strong = signals[0] !== 'question-mark' && wordCount >= 3
    return {
      isQuestion: true,
      confidence: strong ? 'high' : 'medium',
      reason: signals[0]!,
      text: trimmed,
      type,
    }
  }

  // Short utterances with no question signal at all are almost always
  // backchannel ("mhm, sure thing", "yeah okay right").
  if (wordCount <= 2) return reject('too-short')

  // --- Ambiguous -----------------------------------------------------------
  // No explicit signal, but a substantial utterance from the interviewer. In an
  // interview the interviewer's long turns are overwhelmingly prompts, so we
  // answer and flag it rather than risk missing a question.
  //
  // Threshold is 5, not 6: live testing dropped a real five-word question that
  // landed one word under the old bar. Acknowledgements and backchannel are
  // caught by name above, so the extra word costs little.
  if (wordCount >= 5) {
    return { isQuestion: true, confidence: 'low', reason: 'substantial-utterance', text: trimmed, type }
  }

  return reject('no-signal')
}

/**
 * Token-overlap similarity, used to suppress duplicate answers when a provider
 * re-emits a turn or an interviewer restates a question.
 */
export function similarity(a: string, b: string): number {
  const ta = new Set(normalizeQuestion(a).split(' ').filter(Boolean))
  const tb = new Set(normalizeQuestion(b).split(' ').filter(Boolean))
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const token of ta) if (tb.has(token)) shared++
  return shared / Math.max(ta.size, tb.size)
}
