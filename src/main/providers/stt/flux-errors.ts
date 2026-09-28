/**
 * Reconnect-decision predicates, kept dependency-free so they can be unit-tested
 * without pulling in Electron (which `deepgram-flux` does, via credentials).
 *
 * The stakes: mis-classifying a fatal error as transient turns a bad API key into
 * an infinite, invisible "reconnecting" loop; the reverse gives up on a blip.
 */

/**
 * A WebSocket close that reconnecting cannot fix: 1008 (policy) and the
 * application-level 4xxx range Deepgram uses for auth / bad-request. Retrying
 * with the same key and params would only loop.
 */
export function isFatalCloseCode(code: number | undefined): boolean {
  return code === 1008 || (typeof code === 'number' && code >= 4000 && code < 4100)
}

/** A Flux `Error` frame that won't fix itself on reconnect (auth/quota/bad input). */
export function isFatalFluxError(code?: string, description?: string): boolean {
  const haystack = `${code ?? ''} ${description ?? ''}`.toLowerCase()
  return /auth|unauthor|forbidden|invalid|token|api key|quota|payment|billing|not.?found/.test(
    haystack
  )
}
