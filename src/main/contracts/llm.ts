/**
 * LLM plugin contract.
 *
 * Two properties matter more than anything else here:
 *
 *   1. `stream()` must yield its first token as fast as possible — the provider
 *      is responsible for keeping connections warm (see `prewarm`).
 *   2. Generation must be *cancellable*, because interviewers interrupt
 *      themselves and speculative generations are discarded routinely.
 */

export interface LLMCapabilities {
  streaming: boolean
  /** Provider supports explicit prompt caching (Anthropic-style cache_control). */
  promptCaching: boolean
  maxContextTokens: number
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  /** Hint that this block is stable and worth caching, where supported. */
  cacheable?: boolean
}

export interface LLMRequest {
  messages: LLMMessage[]
  model: string
  maxTokens: number
  temperature: number
  /** Aborting must actually stop billing/generation, not just ignore the result. */
  signal: AbortSignal
}

export interface LLMStreamEvent {
  type: 'delta' | 'done' | 'error'
  text?: string
  promptTokens?: number
  completionTokens?: number
  message?: string
  retryable?: boolean
}

export interface LLMProvider {
  readonly name: string
  readonly capabilities: LLMCapabilities
  readonly defaultModel: string
  validate(): void
  /**
   * Open and hold a connection so the first real request does not pay TLS +
   * TCP setup. Measured worth ~400 ms on Groq — the single largest avoidable
   * cost in the whole pipeline.
   */
  prewarm(model: string): Promise<void>
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>
}
