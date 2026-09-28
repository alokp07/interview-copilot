/**
 * The reconnect decision: which failures are worth retrying and which are a dead
 * end. Getting this wrong is what turned a bad API key into an infinite,
 * invisible "reconnecting" loop.
 */

import { describe, expect, it } from 'vitest'
import { isFatalCloseCode, isFatalFluxError } from '@main/providers/stt/flux-errors'

describe('isFatalCloseCode', () => {
  it('treats policy and app-level 4xxx closes as fatal', () => {
    expect(isFatalCloseCode(1008)).toBe(true)
    expect(isFatalCloseCode(4001)).toBe(true)
    expect(isFatalCloseCode(4008)).toBe(true)
  })

  it('treats ordinary network closes as retryable', () => {
    expect(isFatalCloseCode(1006)).toBe(false) // abnormal closure — retry
    expect(isFatalCloseCode(1000)).toBe(false) // normal
    expect(isFatalCloseCode(undefined)).toBe(false)
    expect(isFatalCloseCode(1011)).toBe(false) // server error — retry
  })
})

describe('isFatalFluxError', () => {
  it('stops retrying on auth / quota / bad-request errors', () => {
    expect(isFatalFluxError('UNAUTHORIZED', 'Invalid API key')).toBe(true)
    expect(isFatalFluxError('forbidden')).toBe(true)
    expect(isFatalFluxError(undefined, 'insufficient quota, add payment')).toBe(true)
    expect(isFatalFluxError('BadRequest', 'invalid sample_rate')).toBe(true)
  })

  it('keeps retrying on transient/unknown errors', () => {
    expect(isFatalFluxError('InternalError', 'temporary failure')).toBe(false)
    expect(isFatalFluxError(undefined, undefined)).toBe(false)
    expect(isFatalFluxError('RateLimited', 'slow down')).toBe(false)
  })
})
