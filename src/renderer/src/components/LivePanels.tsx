/**
 * The three live zones, weighted by how much they matter mid-interview.
 *
 * The answer is the hero and gets the space; the question is a compact anchor
 * above it; the transcript is a thin, collapsible strip because it is reference
 * material, not something to read while speaking.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Dot, Label, Listening, Pill } from './primitives'
import type { AnswerView } from '../state/store'
import type { DetectedQuestion, SessionState, TranscriptLine } from '@shared/types'

/** Keeps a scroll container pinned to the bottom unless the user scrolls away. */
function useStickToBottom(deps: unknown[]): {
  scrollRef: React.RefObject<HTMLDivElement | null>
  endRef: React.RefObject<HTMLDivElement | null>
} {
  const scrollRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = (): void => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 28
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Layout effect so the jump happens in the same frame as the new text and
  // never shows a torn intermediate state.
  useLayoutEffect(() => {
    if (pinned.current) endRef.current?.scrollIntoView({ block: 'end' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { scrollRef, endRef }
}

// ---------------------------------------------------------------------------
// Question
// ---------------------------------------------------------------------------

export function QuestionPanel({ question }: { question: DetectedQuestion | null }): ReactNode {
  if (!question) return null

  const tone = question.speculative
    ? 'spec'
    : question.confidence === 'high'
      ? 'live'
      : question.confidence === 'medium'
        ? 'warn'
        : 'danger'

  return (
    <div className="fade-in shrink-0">
      <Label
        right={
          question.speculative ? (
            <Pill tone="spec">predicting</Pill>
          ) : question.confidence !== 'high' ? (
            <Pill tone={tone === 'live' ? 'live' : tone}>{question.confidence} confidence</Pill>
          ) : null
        }
      >
        Question
      </Label>
      <div
        className={`selectable rounded-lg border-l-2 bg-surface py-2 pl-2.5 pr-3 transition-colors duration-200 ${
          question.speculative ? 'border-l-spec' : 'border-l-accent'
        }`}
      >
        <p className="text-[13px] font-medium leading-snug text-fg">{question.text}</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Answer — the hero
// ---------------------------------------------------------------------------

export function AnswerPanel({
  answer,
  sessionState,
  onRegenerate,
}: {
  answer: AnswerView
  sessionState: SessionState
  onRegenerate: () => void
}): ReactNode {
  const { scrollRef, endRef } = useStickToBottom([answer.text])
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(id)
  }, [copied])

  const copy = (): void => {
    void navigator.clipboard.writeText(answer.text).then(() => setCopied(true))
  }

  const hasText = answer.text.length > 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Label
        right={
          hasText && answer.state !== 'thinking' ? (
            <span className="no-drag flex items-center gap-1">
              <button
                type="button"
                onClick={copy}
                className="rounded px-1 py-px text-[9.5px] text-fg-faint transition-colors hover:text-fg-muted"
              >
                {copied ? 'copied' : 'copy'}
              </button>
              <button
                type="button"
                onClick={onRegenerate}
                title="Regenerate (Ctrl+Shift+R)"
                className="rounded px-1 py-px text-[9.5px] text-fg-faint transition-colors hover:text-fg-muted"
              >
                retry
              </button>
            </span>
          ) : (
            <AnswerStatus answer={answer} />
          )
        }
      >
        Answer
      </Label>

      <div
        ref={scrollRef}
        className={`card-raised min-h-0 flex-1 overflow-y-auto px-3.5 py-3 transition-colors duration-200 ${
          answer.speculative ? 'border-spec/35 bg-spec/[0.045]' : ''
        }`}
      >
        {answer.error ? (
          <ErrorState message={answer.error} onRetry={onRegenerate} />
        ) : hasText ? (
          <p className={`answer-text ${answer.state === 'streaming' ? 'caret' : ''}`}>
            {answer.text}
          </p>
        ) : answer.state === 'thinking' ? (
          <ThinkingState />
        ) : (
          <IdleState sessionState={sessionState} />
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}

function AnswerStatus({ answer }: { answer: AnswerView }): ReactNode {
  if (answer.state === 'idle') return null
  const map = {
    thinking: { tone: 'accent' as const, label: 'thinking' },
    streaming: { tone: 'accent' as const, label: 'writing' },
    complete: { tone: 'live' as const, label: 'ready' },
    cancelled: { tone: 'warn' as const, label: 'dropped' },
    error: { tone: 'danger' as const, label: 'failed' },
  }[answer.state]
  if (!map) return null
  return (
    <span className="flex items-center gap-1.5 text-[9.5px] text-fg-faint">
      <Dot tone={map.tone} pulse={answer.state === 'thinking' || answer.state === 'streaming'} />
      {map.label}
    </span>
  )
}

function ThinkingState(): ReactNode {
  return (
    <div className="flex items-center gap-2 py-1">
      <Listening />
      <span className="text-[12px] text-fg-faint">Composing your answer…</span>
    </div>
  )
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  return (
    <div className="py-1">
      <p className="text-[12px] leading-relaxed text-danger">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="no-drag mt-2 rounded-md border border-line-strong bg-raised px-2 py-1 text-[11px] text-fg-muted transition-colors hover:text-fg"
      >
        Try again
      </button>
    </div>
  )
}

/**
 * The idle state used to be an empty box occupying half the window. It now
 * carries the things worth knowing before an interview starts.
 */
function IdleState({ sessionState }: { sessionState: SessionState }): ReactNode {
  if (sessionState === 'running') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2.5 py-6 text-center">
        <Listening />
        <p className="text-[12.5px] font-medium text-fg-muted">Listening</p>
        <p className="max-w-[15rem] text-[11px] leading-relaxed text-fg-faint">
          The answer appears the moment a question is detected — often before the interviewer
          finishes speaking.
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col justify-center gap-3 py-4">
      <div className="text-center">
        <p className="text-[12.5px] font-medium text-fg-muted">Ready when you are</p>
        <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">
          Press Start, or fill in Profile first for answers grounded in your own experience.
        </p>
      </div>
      <div className="mx-auto w-full max-w-[15rem] space-y-1">
        {[
          ['Start / stop', 'Ctrl ⇧ Space'],
          ['Hide window', 'Ctrl ⇧ H'],
          ['Regenerate', 'Ctrl ⇧ R'],
          ['Fade out', 'Ctrl ⇧ O'],
        ].map(([action, keys]) => (
          <div key={keys} className="flex items-center justify-between gap-3">
            <span className="text-[10.5px] text-fg-faint">{action}</span>
            <kbd className="rounded border border-line bg-base px-1.5 py-px font-mono text-[9.5px] text-fg-muted">
              {keys}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transcript — collapsible, small by default
// ---------------------------------------------------------------------------

export function TranscriptPanel({
  lines,
  interimInterviewer,
  interimCandidate,
  expanded,
  onToggle,
}: {
  lines: TranscriptLine[]
  interimInterviewer: string
  interimCandidate: string
  expanded: boolean
  onToggle: () => void
}): ReactNode {
  const { scrollRef, endRef } = useStickToBottom([
    lines.length,
    interimInterviewer,
    interimCandidate,
  ])

  const empty = lines.length === 0 && !interimInterviewer && !interimCandidate
  const latest = lines.at(-1)

  return (
    <div className={`flex shrink-0 flex-col ${expanded ? 'h-[38%]' : ''}`}>
      <Label
        right={
          <button
            type="button"
            onClick={onToggle}
            className="no-drag rounded px-1 py-px text-[9.5px] text-fg-faint transition-colors hover:text-fg-muted"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        }
      >
        Transcript
      </Label>

      {expanded ? (
        <div
          ref={scrollRef}
          className="selectable min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-surface px-2.5 py-2 text-[11.5px] leading-relaxed"
        >
          {empty ? (
            <p className="text-fg-faint">Waiting for audio…</p>
          ) : (
            <>
              {lines.map((line) => (
                <TranscriptRow key={line.id} speaker={line.speaker} text={line.text} />
              ))}
              {interimInterviewer ? (
                <TranscriptRow speaker="interviewer" text={interimInterviewer} interim />
              ) : null}
              {interimCandidate ? (
                <TranscriptRow speaker="candidate" text={interimCandidate} interim />
              ) : null}
            </>
          )}
          <div ref={endRef} />
        </div>
      ) : (
        // Collapsed: one line of the most recent speech, so the strip still
        // proves audio is flowing without taking space from the answer.
        <div className="selectable truncate rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[11.5px]">
          {interimInterviewer ? (
            <span className="text-fg-muted italic">{interimInterviewer}</span>
          ) : latest ? (
            <>
              <span
                className={
                  latest.speaker === 'interviewer'
                    ? 'font-medium text-accent-soft'
                    : 'font-medium text-fg-faint'
                }
              >
                {latest.speaker === 'interviewer' ? 'Them' : 'You'}
              </span>
              <span className="text-fg-faint"> · </span>
              <span className="text-fg-muted">{latest.text}</span>
            </>
          ) : (
            <span className="text-fg-faint">Waiting for audio…</span>
          )}
        </div>
      )}
    </div>
  )
}

function TranscriptRow({
  speaker,
  text,
  interim = false,
}: {
  speaker: 'interviewer' | 'candidate'
  text: string
  interim?: boolean
}): ReactNode {
  const isInterviewer = speaker === 'interviewer'
  return (
    <p className={`mb-1 last:mb-0 ${interim ? 'italic' : ''}`}>
      <span
        className={`font-medium ${
          isInterviewer
            ? interim
              ? 'text-accent-soft/70'
              : 'text-accent-soft'
            : 'text-fg-faint'
        }`}
      >
        {isInterviewer ? 'Them' : 'You'}
      </span>
      <span className="text-fg-faint"> · </span>
      <span className={isInterviewer ? 'text-fg' : 'text-fg-muted'}>{text}</span>
    </p>
  )
}
