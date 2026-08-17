/**
 * Minimal logger with mandatory secret redaction.
 *
 * Interview audio, transcripts and resumes are sensitive, and API keys must
 * never reach a log line. Rather than trusting call sites to remember that,
 * every value passes through `redact()` on the way out.
 */

type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

const configuredLevel = (): Level => {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase()
  return raw in LEVEL_ORDER ? (raw as Level) : 'info'
}

/** Registered secrets, longest first so overlapping values redact correctly. */
const secrets = new Set<string>()

export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 8) secrets.add(value)
}

export function forgetSecrets(): void {
  secrets.clear()
}

/** Patterns that look like credentials even if we never registered them. */
const KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgsk_[A-Za-z0-9_-]{16,}/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
  /\bToken\s+[A-Za-z0-9._-]{16,}/gi,
]

export function redact(input: unknown): unknown {
  if (typeof input === 'string') return redactString(input)
  if (Array.isArray(input)) return input.map(redact)
  if (input instanceof Error) {
    return { name: input.name, message: redactString(input.message) }
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input)) {
      out[k] = /key|secret|token|authorization|password/i.test(k) ? '[redacted]' : redact(v)
    }
    return out
  }
  return input
}

function redactString(s: string): string {
  let out = s
  // Longest first: a short secret that is a substring of a longer one must not
  // partially mask it and leave the tail visible.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (out.includes(secret)) out = out.split(secret).join('[redacted]')
  }
  for (const re of KEY_PATTERNS) out = out.replace(re, '[redacted]')
  return out
}

function emit(level: Level, scope: string, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[configuredLevel()]) return
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} ${scope} — ${redactString(message)}`
  const args = meta === undefined ? [line] : [line, redact(meta)]
  if (level === 'error') console.error(...args)
  else if (level === 'warn') console.warn(...args)
  else console.log(...args)
}

export interface Logger {
  debug(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
  child(sub: string): Logger
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => emit('debug', scope, m, meta),
    info: (m, meta) => emit('info', scope, m, meta),
    warn: (m, meta) => emit('warn', scope, m, meta),
    error: (m, meta) => emit('error', scope, m, meta),
    child: (sub) => createLogger(`${scope}:${sub}`),
  }
}
