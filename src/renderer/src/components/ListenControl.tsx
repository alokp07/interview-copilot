/**
 * Push-to-listen control — the answer to "stop answering things I didn't ask for".
 *
 * In manual mode Cue stays silent until the candidate signals, two ways:
 *   • Hold  — answers every question while the button is physically held.
 *   • Arm   — answers the *next* detected question, then disarms (also Ctrl+Shift+A).
 *
 * `always` mode keeps the v1 behavior and shows a steady indicator instead of the
 * button. Audio and memory keep flowing in every mode, so context is never lost
 * between presses — only whether a detected question becomes an answer changes.
 */

import { useEffect, type ReactNode } from 'react'
import { Listening } from './primitives'
import type { ListenIndicator, ListenMode } from '@shared/types'

export function ListenControl({
  listenMode,
  indicator,
  onChangeMode,
}: {
  listenMode: ListenMode
  indicator: ListenIndicator
  onChangeMode: (mode: ListenMode) => void
}): ReactNode {
  const holding = indicator === 'listening'
  const armed = indicator === 'armed'

  // Safety net: if the pointer is released outside the button, or the window
  // loses focus mid-press, drop the hold so it can never stick "on".
  useEffect(() => {
    if (!holding) return
    const release = (): void => window.cue.setListen('idle')
    window.addEventListener('pointerup', release)
    window.addEventListener('blur', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('blur', release)
    }
  }, [holding])

  return (
    <div className="fade-in flex shrink-0 items-center gap-2">
      {listenMode === 'always' ? (
        <div className="flex flex-1 items-center gap-2 rounded-lg border border-live/25 bg-live/[0.06] px-3 py-2">
          <Listening />
          <span className="text-[12px] font-medium text-live">Always answering</span>
          <span className="ml-auto text-[10px] text-fg-faint">every question</span>
        </div>
      ) : (
        <div className="flex flex-1 items-center gap-1.5">
          <button
            type="button"
            onPointerDown={() => window.cue.setListen('holding')}
            onPointerUp={() => window.cue.setListen('idle')}
            onPointerLeave={() => holding && window.cue.setListen('idle')}
            onPointerCancel={() => window.cue.setListen('idle')}
            title="Hold to let Cue answer while pressed"
            className={`no-drag flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-[12px] font-semibold transition-colors duration-100 select-none ${
              holding
                ? 'border-accent bg-accent text-[#0a0b0d]'
                : 'border-line-strong bg-raised text-fg-muted hover:text-fg'
            }`}
          >
            {holding ? (
              <>
                <Listening />
                Listening…
              </>
            ) : (
              'Hold to listen'
            )}
          </button>

          <button
            type="button"
            onClick={() => window.cue.setListen(armed ? 'idle' : 'armed')}
            title="Answer the next question, then stop — Ctrl+Shift+A"
            className={`no-drag flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] font-medium transition-colors duration-100 ${
              armed
                ? 'border-spec bg-spec/15 text-spec'
                : 'border-line-strong bg-raised text-fg-muted hover:text-fg'
            }`}
          >
            {armed ? (
              <>
                <span className="pulse inline-block h-1.5 w-1.5 rounded-full bg-spec" />
                Armed
              </>
            ) : (
              'Arm next'
            )}
          </button>
        </div>
      )}

      {/* Quick mode switch, so the candidate can flip to always-on without a Settings dive. */}
      <div className="no-drag flex shrink-0 items-center rounded-lg bg-base p-[2px]">
        {(['manual', 'always'] as ListenMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => onChangeMode(m)}
            className={`rounded-[6px] px-2 py-[3px] text-[10px] capitalize transition-colors duration-100 ${
              listenMode === m
                ? 'bg-overlay text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.05)]'
                : 'text-fg-faint hover:text-fg-muted'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
    </div>
  )
}
