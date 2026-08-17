import type { ReactNode } from 'react'

export type Tone = 'live' | 'warn' | 'danger' | 'idle' | 'accent' | 'spec'

const DOT_TONE: Record<Tone, string> = {
  live: 'bg-live',
  warn: 'bg-warn',
  danger: 'bg-danger',
  accent: 'bg-accent',
  spec: 'bg-spec',
  idle: 'bg-line-strong',
}

export function Dot({
  tone,
  pulse = false,
  size = 6,
  title,
}: {
  tone: Tone
  pulse?: boolean
  size?: number
  title?: string
}): ReactNode {
  return (
    <span
      title={title}
      style={{ width: size, height: size }}
      className={`inline-block shrink-0 rounded-full ${DOT_TONE[tone]} ${pulse ? 'pulse' : ''}`}
    />
  )
}

/**
 * Input level meter. Segmented rather than continuous — discrete blocks read as
 * "signal present" at a glance, where a smooth bar needs to be studied.
 */
export function Meter({ level, active }: { level: number; active: boolean }): ReactNode {
  const segments = 5
  const lit = active ? Math.round(Math.min(1, level) * segments) : 0
  return (
    <span className="inline-flex items-center gap-[2px]" aria-hidden>
      {Array.from({ length: segments }, (_, i) => (
        <span
          key={i}
          className={`h-[7px] w-[2.5px] rounded-full transition-colors duration-100 ${
            i < lit ? 'bg-live' : 'bg-line-strong'
          }`}
        />
      ))}
    </span>
  )
}

/** Animated bars used while listening with nothing yet to show. */
export function Listening(): ReactNode {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="bar h-3 w-[3px] rounded-full bg-accent" />
      ))}
    </span>
  )
}

export function Label({ children, right }: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
      <span className="label">{children}</span>
      {right}
    </div>
  )
}

export function Pill({
  children,
  tone = 'idle',
}: {
  children: ReactNode
  tone?: Tone
}): ReactNode {
  const tones: Record<Tone, string> = {
    live: 'bg-live/12 text-live',
    warn: 'bg-warn/12 text-warn',
    danger: 'bg-danger/12 text-danger',
    accent: 'bg-accent/12 text-accent-soft',
    spec: 'bg-spec/14 text-spec',
    idle: 'bg-overlay text-fg-faint',
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] text-[9.5px] font-medium tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  )
}

export function Button({
  children,
  onClick,
  tone = 'ghost',
  disabled,
  title,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  tone?: 'ghost' | 'primary' | 'danger' | 'subtle'
  disabled?: boolean
  title?: string
  className?: string
}): ReactNode {
  const tones = {
    ghost:
      'bg-raised hover:bg-overlay text-fg-muted hover:text-fg border border-line-strong',
    subtle: 'bg-transparent hover:bg-raised text-fg-faint hover:text-fg-muted border border-transparent',
    primary:
      'bg-accent hover:bg-accent-soft text-[#0a0b0d] border border-transparent font-semibold',
    danger: 'bg-danger/12 hover:bg-danger/20 text-danger border border-danger/25 font-medium',
  }[tone]

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`no-drag inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-[5px] text-[11.5px] transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-40 ${tones} ${className}`}
    >
      {children}
    </button>
  )
}

/** Square icon button, sized for the title bar. */
export function IconButton({
  children,
  onClick,
  title,
  tone = 'subtle',
}: {
  children: ReactNode
  onClick?: () => void
  title?: string
  tone?: 'subtle' | 'danger'
}): ReactNode {
  const tones = {
    subtle: 'text-fg-faint hover:text-fg hover:bg-raised',
    danger: 'text-fg-faint hover:text-danger hover:bg-danger/12',
  }[tone]
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`no-drag flex h-[22px] w-[22px] items-center justify-center rounded-md transition-colors duration-100 ${tones}`}
    >
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-fg-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[10px] leading-snug text-fg-faint">{hint}</span> : null}
    </label>
  )
}

export function TextArea({
  value,
  onChange,
  rows = 3,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  rows?: number
  placeholder?: string
}): ReactNode {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="field no-drag selectable resize-y leading-relaxed"
    />
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  type?: string
}): ReactNode {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="field no-drag selectable"
    />
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (value: T) => void
  options: Array<{ value: T; label: string }>
}): ReactNode {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="field no-drag cursor-pointer appearance-none truncate pr-7"
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 4.5L6 8.5L10 4.5' stroke='%23626977' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 8px center',
        // Explicit size: without it the SVG scales to the full control height.
        backgroundSize: '10px 10px',
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: string
  hint?: string
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="no-drag group flex w-full items-start justify-between gap-3 rounded-lg px-1.5 py-2 text-left transition-colors hover:bg-surface"
    >
      <span className="min-w-0">
        <span className="block text-[12px] text-fg">{label}</span>
        {hint ? (
          <span className="mt-0.5 block text-[10px] leading-snug text-fg-faint">{hint}</span>
        ) : null}
      </span>
      <span
        className={`mt-[2px] flex h-[16px] w-[28px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-150 ${
          checked ? 'bg-accent' : 'bg-line-strong'
        }`}
      >
        <span
          className={`h-3 w-3 rounded-full bg-base transition-transform duration-150 ${
            checked ? 'translate-x-3' : 'translate-x-0'
          }`}
        />
      </span>
    </button>
  )
}

export function Section({
  title,
  children,
}: {
  title: string
  children: ReactNode
}): ReactNode {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="label">{title}</span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {children}
    </section>
  )
}
