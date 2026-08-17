/**
 * Latency instrumentation.
 *
 * The product is judged on one number: the gap between "the interviewer stopped
 * talking" and "the first useful token is on screen". Everything here exists to
 * make that number, and its constituent parts, observable rather than guessed at.
 *
 * All marks share one monotonic clock (`now()`), so differences are meaningful
 * even if the wall clock steps.
 */

import { performance } from 'node:perf_hooks'
import type { LatencySummary, TurnTrace } from '@shared/types'

export const now = (): number => performance.now()

/** Wall-clock anchor, so traces can be rendered as `21:31:14.210` timestamps. */
const EPOCH_WALL = Date.now()
const EPOCH_MONO = performance.now()

export function toWallClock(mono: number): string {
  const d = new Date(EPOCH_WALL + (mono - EPOCH_MONO))
  return (
    `${String(d.getHours()).padStart(2, '0')}:` +
    `${String(d.getMinutes()).padStart(2, '0')}:` +
    `${String(d.getSeconds()).padStart(2, '0')}.` +
    `${String(d.getMilliseconds()).padStart(3, '0')}`
  )
}

export class TraceRecorder {
  private trace: TurnTrace

  constructor(questionId: string) {
    this.trace = { questionId }
  }

  mark<K extends keyof TurnTrace>(key: K, value: TurnTrace[K] = now() as TurnTrace[K]): void {
    // First write wins for timing marks: if a speculative generation survives,
    // its original `llmRequest`/`firstToken` are the honest numbers.
    if (typeof value === 'number' && typeof this.trace[key] === 'number') return
    this.trace[key] = value
  }

  /** Overwrite unconditionally — used when a speculation is discarded and redone. */
  reset<K extends keyof TurnTrace>(key: K, value: TurnTrace[K]): void {
    this.trace[key] = value
  }

  get snapshot(): TurnTrace {
    return { ...this.trace }
  }

  summarize(): LatencySummary {
    const t = this.trace
    // Prefer the confirmed end-of-turn; before it exists, the eager one stands in.
    const end = t.speechEnd ?? t.eagerEnd ?? null
    return {
      answerLatencyMs: end !== null && t.firstToken !== undefined ? t.firstToken - end : null,
      ttftMs:
        t.llmRequest !== undefined && t.firstToken !== undefined
          ? t.firstToken - t.llmRequest
          : null,
      totalMs:
        end !== null && t.complete !== undefined ? t.complete - end : null,
      speculationHit: t.speculationHit === true,
    }
  }

  /** Human-readable breakdown, in the format requested for debugging. */
  format(): string {
    const t = this.trace
    const rows: Array<[string, number | undefined]> = [
      ['Speech start     ', t.speechStart],
      ['Eager end-of-turn', t.eagerEnd],
      ['End of turn      ', t.speechEnd],
      ['Question gated   ', t.gated],
      ['LLM request      ', t.llmRequest],
      ['First token      ', t.firstToken],
      ['Generation done  ', t.complete],
    ]
    const base = t.speechStart ?? t.eagerEnd ?? t.speechEnd
    const lines = rows
      .filter(([, v]) => v !== undefined)
      .map(([label, v]) => {
        const rel = base !== undefined ? `  (+${Math.round(v! - base)}ms)` : ''
        return `  ${label}: ${toWallClock(v!)}${rel}`
      })
    const s = this.summarize()
    lines.push(
      `  ${'—'.repeat(20)}`,
      `  answer latency  : ${s.answerLatencyMs === null ? 'n/a' : `${Math.round(s.answerLatencyMs)}ms`}` +
        (s.speculationHit ? '  [speculation hit]' : ''),
      `  llm ttft        : ${s.ttftMs === null ? 'n/a' : `${Math.round(s.ttftMs)}ms`}`,
      `  total           : ${s.totalMs === null ? 'n/a' : `${Math.round(s.totalMs)}ms`}`
    )
    return lines.join('\n')
  }
}

/** Rolling aggregate across a session, for the UI's latency readout. */
export class LatencyStats {
  private samples: number[] = []
  private ttfts: number[] = []
  private hits = 0
  private total = 0

  add(summary: LatencySummary): void {
    this.total++
    if (summary.speculationHit) this.hits++
    if (summary.answerLatencyMs !== null) this.samples.push(summary.answerLatencyMs)
    if (summary.ttftMs !== null) this.ttfts.push(summary.ttftMs)
  }

  get count(): number {
    return this.total
  }

  private static percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null
    const sorted = [...values].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[idx] ?? null
  }

  report(): {
    p50: number | null
    p95: number | null
    ttftP50: number | null
    speculationHitRate: number | null
    n: number
  } {
    return {
      p50: LatencyStats.percentile(this.samples, 50),
      p95: LatencyStats.percentile(this.samples, 95),
      ttftP50: LatencyStats.percentile(this.ttfts, 50),
      speculationHitRate: this.total > 0 ? this.hits / this.total : null,
      n: this.total,
    }
  }

  reset(): void {
    this.samples = []
    this.ttfts = []
    this.hits = 0
    this.total = 0
  }
}
