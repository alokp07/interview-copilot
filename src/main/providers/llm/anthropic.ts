/**
 * Anthropic Messages API adapter.
 *
 * Kept separate from the OpenAI-compatible adapter because the wire format
 * genuinely differs — system prompt is a top-level field, events are typed SSE
 * rather than choice deltas — and because Anthropic is the only supported
 * provider with *explicit* prompt caching. That matters here: the candidate
 * profile and style rules are identical on every request in a session, so
 * marking them `cache_control: ephemeral` removes them from the per-question
 * cost and shaves prompt-processing time.
 */

import type { IncomingMessage } from 'node:http'
import https from 'node:https'
import { createLogger } from '@main/core/logger'
import { getCredential } from '@main/config/credentials'
import { ReasoningFilter } from '@main/providers/llm/openai-compatible'
import type {
  LLMCapabilities,
  LLMProvider,
  LLMRequest,
  LLMStreamEvent,
} from '@main/contracts/llm'

const log = createLogger('llm:anthropic')

const HOST = 'api.anthropic.com'
const PATH = '/v1/messages'
const VERSION = '2023-06-01'

interface AnthropicEvent {
  type: string
  delta?: { type?: string; text?: string }
  message?: { usage?: { input_tokens?: number; output_tokens?: number } }
  usage?: { output_tokens?: number }
  error?: { type?: string; message?: string }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic'
  readonly defaultModel = 'claude-haiku-4-5'
  readonly capabilities: LLMCapabilities = {
    streaming: true,
    promptCaching: true,
    maxContextTokens: 200_000,
  }

  private readonly agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 5_000,
    maxSockets: 6,
    maxFreeSockets: 4,
    timeout: 120_000,
  })
  private warmTimer: NodeJS.Timeout | null = null

  validate(): void {
    if (!getCredential('ANTHROPIC_API_KEY')) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Add it in Settings, or put it in a .env file at the project root.'
      )
    }
  }

  private headers(): Record<string, string> {
    const key = getCredential('ANTHROPIC_API_KEY')
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set.')
    return {
      'x-api-key': key,
      'anthropic-version': VERSION,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      connection: 'keep-alive',
    }
  }

  async prewarm(model: string): Promise<void> {
    // Anthropic has no free GET endpoint that keeps a socket hot, so we warm it
    // with a 1-token generation. Negligible cost, and it primes the TLS session.
    await new Promise<void>((resolve) => {
      const body = JSON.stringify({
        model: model || this.defaultModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      })
      try {
        const req = https.request(
          {
            host: HOST,
            path: PATH,
            method: 'POST',
            agent: this.agent,
            headers: { ...this.headers(), 'Content-Length': Buffer.byteLength(body) },
            timeout: 8_000,
          },
          (res) => {
            res.resume()
            res.on('end', () => resolve())
          }
        )
        req.on('error', (err) => {
          log.debug('warm-up failed', err)
          resolve()
        })
        req.on('timeout', () => {
          req.destroy()
          resolve()
        })
        req.end(body)
      } catch {
        resolve()
      }
    })
    if (this.warmTimer) clearInterval(this.warmTimer)
    this.warmTimer = setInterval(() => void this.prewarmQuiet(model), 60_000)
    this.warmTimer.unref?.()
  }

  private async prewarmQuiet(model: string): Promise<void> {
    const saved = this.warmTimer
    this.warmTimer = null
    await this.prewarm(model)
    if (this.warmTimer) clearInterval(this.warmTimer)
    this.warmTimer = saved
  }

  dispose(): void {
    if (this.warmTimer) clearInterval(this.warmTimer)
    this.warmTimer = null
    this.agent.destroy()
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    // Anthropic takes the system prompt out of band. Stable blocks are marked
    // cacheable so repeat questions in a session skip re-processing them.
    const systemBlocks = request.messages
      .filter((m) => m.role === 'system')
      .map((m) =>
        m.cacheable
          ? { type: 'text' as const, text: m.content, cache_control: { type: 'ephemeral' as const } }
          : { type: 'text' as const, text: m.content }
      )

    const turns = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    const body = JSON.stringify({
      model: request.model || this.defaultModel,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
      ...(systemBlocks.length > 0 ? { system: systemBlocks } : {}),
      messages: turns.length > 0 ? turns : [{ role: 'user', content: '...' }],
    })

    let req: ReturnType<typeof https.request>
    let res: IncomingMessage
    try {
      ;({ req, res } = await this.open(body, request.signal))
    } catch (err) {
      if (request.signal.aborted) return
      yield { type: 'error', message: (err as Error).message, retryable: true }
      return
    }

    const status = res.statusCode ?? 0
    if (status < 200 || status >= 300) {
      const text = await new Promise<string>((resolve) => {
        let out = ''
        res.setEncoding('utf8')
        res.on('data', (c: string) => {
          if (out.length < 2048) out += c
        })
        res.on('end', () => resolve(out))
        res.on('error', () => resolve(out))
      })
      yield {
        type: 'error',
        message: `Anthropic returned ${status}. ${text.slice(0, 300)}`,
        retryable: status === 429 || status >= 500,
      }
      return
    }

    const onAbort = (): void => {
      req.destroy()
      res.destroy()
    }
    request.signal.addEventListener('abort', onAbort, { once: true })

    let buffer = ''
    let promptTokens: number | undefined
    let completionTokens: number | undefined
    // Defensive: a model routed here should not inline a scratchpad, but the
    // candidate must never see one if it does.
    const filter = new ReasoningFilter()

    try {
      for await (const chunk of res) {
        if (request.signal.aborted) return
        buffer += (chunk as Buffer).toString('utf8')
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue

          let event: AnthropicEvent
          try {
            event = JSON.parse(payload) as AnthropicEvent
          } catch {
            continue
          }

          switch (event.type) {
            case 'message_start':
              promptTokens = event.message?.usage?.input_tokens ?? promptTokens
              break
            case 'content_block_delta': {
              if (!event.delta?.text) break
              const visible = filter.push(event.delta.text)
              if (visible) yield { type: 'delta', text: visible }
              break
            }
            case 'message_delta':
              completionTokens = event.usage?.output_tokens ?? completionTokens
              break
            case 'error':
              yield {
                type: 'error',
                message: event.error?.message ?? 'anthropic error',
                retryable: event.error?.type === 'overloaded_error',
              }
              return
            default:
              break
          }
        }
      }
      const tail = filter.flush()
      if (tail) yield { type: 'delta', text: tail }
      yield { type: 'done', promptTokens, completionTokens }
    } catch (err) {
      if (request.signal.aborted) return
      yield { type: 'error', message: (err as Error).message, retryable: true }
    } finally {
      request.signal.removeEventListener('abort', onAbort)
    }
  }

  private open(
    body: string,
    signal: AbortSignal
  ): Promise<{ req: ReturnType<typeof https.request>; res: IncomingMessage }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      const req = https.request(
        {
          host: HOST,
          path: PATH,
          method: 'POST',
          agent: this.agent,
          headers: { ...this.headers(), 'Content-Length': Buffer.byteLength(body) },
          timeout: 30_000,
        },
        (res) => resolve({ req, res })
      )
      req.on('error', reject)
      req.on('timeout', () => req.destroy(new Error('request timed out')))
      signal.addEventListener('abort', () => req.destroy(), { once: true })
      req.end(body)
    })
  }
}
