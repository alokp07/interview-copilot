/**
 * Window chrome: title bar and status strip.
 *
 * Between them they answer "is this working?" in the half-second glance the
 * candidate can afford. Everything here is sized for peripheral reading.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { Button, Dot, IconButton, Meter, type Tone } from './primitives'
import { summarizeTraces, useStore, type View } from '../state/store'
import type { SessionState, StreamStatus, TransportState } from '@shared/types'

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'profile', label: 'Profile' },
  { id: 'settings', label: 'Settings' },
]

export function TitleBar({
  onToggleSession,
  sessionState,
}: {
  onToggleSession: () => void
  sessionState: SessionState
}): ReactNode {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const running = sessionState === 'running'
  const busy = sessionState === 'starting' || sessionState === 'stopping'

  return (
    <header className="drag flex items-center gap-2 border-b border-line bg-surface px-2 py-1.5">
      <span className="flex shrink-0 items-center gap-1.5 pl-0.5">
        <Dot tone={running ? 'live' : 'idle'} pulse={running} size={7} />
        <span className="text-[12px] font-semibold tracking-tight text-fg">Cue</span>
      </span>

      <Timer running={running} />

      {/* Segmented control reads as one object, unlike three separate buttons. */}
      <nav className="no-drag ml-auto flex shrink-0 items-center rounded-lg bg-base p-[2px]">
        {VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setView(item.id)}
            className={`rounded-[6px] px-2 py-[3px] text-[11px] transition-colors duration-100 ${
              view === item.id
                ? 'bg-overlay text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]'
                : 'text-fg-faint hover:text-fg-muted'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <Button
        tone={running ? 'danger' : 'primary'}
        onClick={onToggleSession}
        disabled={busy}
        title="Ctrl+Shift+Space"
        className="shrink-0"
      >
        {busy ? '…' : running ? 'Stop' : 'Start'}
      </Button>

      <span className="flex shrink-0 items-center gap-0.5">
        <IconButton onClick={() => void window.cue.hideOverlay()} title="Hide — Ctrl+Shift+H">
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </IconButton>
        <IconButton onClick={() => void window.cue.quit()} title="Quit" tone="danger">
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
            <path
              d="M3 3l6 6M9 3l-6 6"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </IconButton>
      </span>
    </header>
  )
}

function Timer({ running }: { running: boolean }): ReactNode {
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    if (!running) {
      setSeconds(0)
      return
    }
    const started = Date.now()
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(id)
  }, [running])

  if (!running) return null
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  return (
    <span className="font-mono text-[10.5px] tabular-nums text-fg-faint">
      {mm}:{ss}
    </span>
  )
}

const TRANSPORT_TONE: Record<TransportState, Tone> = {
  connected: 'live',
  connecting: 'warn',
  reconnecting: 'warn',
  error: 'danger',
  closed: 'idle',
  idle: 'idle',
}

export function StatusBar({ showLatency }: { showLatency: boolean }): ReactNode {
  const streams = useStore((s) => s.streams)
  const traces = useStore((s) => s.traces)
  const sessionError = useStore((s) => s.sessionError)
  const { last, median, hitRate } = summarizeTraces(traces)

  return (
    <footer className="shrink-0 border-t border-line bg-surface">
      {sessionError ? (
        <p
          className="truncate border-b border-danger/20 bg-danger/10 px-2.5 py-1 text-[10px] text-danger"
          title={sessionError}
        >
          {sessionError}
        </p>
      ) : null}

      <div className="flex items-center gap-3 px-2.5 py-[5px] text-[10px] text-fg-faint">
        <Channel label="Them" status={streams.system} />
        <Channel label="You" status={streams.mic} />

        {showLatency ? (
          <span className="ml-auto flex items-center gap-2 font-mono tabular-nums">
            {last !== null ? (
              <span
                title="Interviewer stopped speaking → first answer token"
                className={
                  last < 0 ? 'text-spec' : last < 800 ? 'text-live' : 'text-warn'
                }
              >
                {last < 0 ? `−${Math.abs(Math.round(last))}` : Math.round(last)}
                <span className="text-fg-faint">ms</span>
              </span>
            ) : (
              <span className="text-fg-faint">—</span>
            )}
            {median !== null ? (
              <span className="text-fg-faint" title="Median this session">
                p50 {Math.round(median)}
              </span>
            ) : null}
            {hitRate !== null && hitRate > 0 ? (
              <span
                className="text-fg-faint"
                title="Answers that began before the question finished"
              >
                ⚡{Math.round(hitRate * 100)}%
              </span>
            ) : null}
          </span>
        ) : (
          <span className="ml-auto" />
        )}
      </div>
    </footer>
  )
}

function Channel({ label, status }: { label: string; status: StreamStatus }): ReactNode {
  const live = status.capture === 'live'
  const broken = status.capture === 'denied' || status.capture === 'error' || status.capture === 'unavailable'
  const tone: Tone = broken ? 'danger' : live ? TRANSPORT_TONE[status.transport] : 'idle'
  const detail = broken ? status.capture : live ? status.transport : status.capture

  return (
    <span
      className="flex items-center gap-1.5"
      title={status.error ?? `${label}: ${detail}`}
    >
      <Dot
        tone={tone}
        pulse={status.transport === 'connecting' || status.transport === 'reconnecting'}
      />
      <span className={live ? 'text-fg-muted' : ''}>{label}</span>
      <Meter level={status.level} active={live} />
    </span>
  )
}
