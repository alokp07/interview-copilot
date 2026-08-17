/**
 * One adapter for every OpenAI-compatible `/chat/completions` endpoint:
 * Groq, OpenRouter, OpenAI, Together, DeepSeek, vLLM, Ollama, LM Studio.
 * Adding a provider is a table entry, not a class.
 *
 * Built on `node:https` rather than `fetch` for one specific reason: connection
 * warmth. Benchmarked on Groq, a cold connection costs 545 ms to first token and
 * a warm one 115–210 ms. Node's global fetch dispatcher parks idle sockets for
 * only ~4 s, so with questions arriving a minute apart *every* answer would pay
 * the cold price — which alone would blow the latency budget. An explicit
 * keep-alive agent plus a periodic warm-up ping keeps the socket hot instead.
 */

import type { IncomingMessage } from 'node:http'
import https from 'node:https'
import { createLogger } from '@main/core/logger'
import { getCredential, type CredentialKey } from '@main/config/credentials'
import { modelParams } from '@shared/models'
import type {
  LLMCapabilities,
  LLMProvider,
  LLMRequest,
  LLMStreamEvent,
} from '@main/contracts/llm'

const log = createLogger('llm:openai-compatible')

export interface OpenAICompatibleConfig {
  name: string
  host: string
  path: string
  credentialKey: CredentialKey
  defaultModel: string
  maxContextTokens: number
  extraHeaders?: Record<string, string>
  /** Cheap GET used to establish/keep the TLS connection. */
  warmPath?: string
}

interface ChatChunk {
  choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
  error?: { message?: string; type?: string } | null
}

/** Status codes worth retrying on a different attempt. */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])

/**
 * Strips `<think>…</think>` blocks out of a token stream.
 *
 * Some reasoning models (Qwen 3 among them) emit their scratchpad inline in
 * `content` rather than in a separate field. Left alone, the candidate would
 * watch the model's internal monologue appear where their answer should be.
 * Tags can straddle chunk boundaries, so a partial tag is held back rather than
 * emitted and regretted.
 */
export class ReasoningFilter {
  private buffer = ''
  private inside = false

  private static readonly OPEN = '<think>'
  private static readonly CLOSE = '</think>'

  /** Longest suffix of `text` that could still grow into `tag`. */
  private static partialTail(text: string, tag: string): number {
    const max = Math.min(text.length, tag.length - 1)
    for (let len = max; len > 0; len--) {
      if (tag.startsWith(text.slice(text.length - len))) return len
    }
    return 0
  }

  push(delta: string): string {
    this.buffer += delta
    let out = ''

    for (;;) {
      if (this.inside) {
        const close = this.buffer.indexOf(ReasoningFilter.CLOSE)
        if (close === -1) {
          // Keep only what might be the start of the closing tag.
          const keep = ReasoningFilter.partialTail(this.buffer, ReasoningFilter.CLOSE)
          this.buffer = this.buffer.slice(this.buffer.length - keep)
          return out
        }
        this.buffer = this.buffer.slice(close + ReasoningFilter.CLOSE.length)
        this.inside = false
        continue
      }

      const open = this.buffer.indexOf(ReasoningFilter.OPEN)
      if (open !== -1) {
        out += this.buffer.slice(0, open)
        this.buffer = this.buffer.slice(open + ReasoningFilter.OPEN.length)
        this.inside = true
        continue
      }

      const keep = ReasoningFilter.partialTail(this.buffer, ReasoningFilter.OPEN)
      out += this.buffer.slice(0, this.buffer.length - keep)
      this.buffer = this.buffer.slice(this.buffer.length - keep)
      return out
    }
  }

  /** Emit anything held back that turned out not to be a tag. */
  flush(): string {
    if (this.inside) return ''
    const rest = this.buffer
    this.buffer = ''
    return rest
  }
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string
  readonly defaultModel: string
  readonly capabilities: LLMCapabilities

  private readonly agent: https.Agent
  private warmTimer: NodeJS.Timeout | null = null

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.name = config.name
    this.defaultModel = config.defaultModel
    this.capabilities = {
      streaming: true,
      promptCaching: false,
      maxContextTokens: config.maxContextTokens,
    }
    this.agent = new https.Agent({
      keepAlive: true,
      // TCP keep-alive probes start after 5 s of idle, so a NAT or the server
      // is less likely to silently drop the socket between questions.
      keepAliveMsecs: 5_000,
      maxSockets: 6,
      maxFreeSockets: 4,
      timeout: 120_000,
    })
  }

  validate(): void {
    if (!getCredential(this.config.credentialKey)) {
      throw new Error(
        `${this.config.credentialKey} is not set. Add it in Settings, or put it in a .env file at the project root.`
      )
    }
  }

  private headers(): Record<string, string> {
    const key = getCredential(this.config.credentialKey)
    if (!key) throw new Error(`${this.config.credentialKey} is not set.`)
    return {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Connection: 'keep-alive',
      ...this.config.extraHeaders,
    }
  }

  /**
   * Establishes the TLS session and then keeps re-touching it, because a pooled
   * socket the server has quietly closed is worth nothing.
   */
  async prewarm(_model: string): Promise<void> {
    void _model
    await this.ping()
    if (this.warmTimer) clearInterval(this.warmTimer)
    this.warmTimer = setInterval(() => {
      void this.ping()
    }, 20_000)
    this.warmTimer.unref?.()
  }

  private ping(): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const done = (): void => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      try {
        const req = https.request(
          {
            host: this.config.host,
            path: this.config.warmPath ?? '/v1/models',
            method: 'GET',
            agent: this.agent,
            headers: this.headers(),
            timeout: 8_000,
          },
          (res) => {
            res.resume() // drain so the socket returns to the free pool
            res.on('end', done)
          }
        )
        req.on('error', (err) => {
          log.debug(`${this.name}: warm-up ping failed`, err)
          done()
        })
        req.on('timeout', () => {
          req.destroy()
          done()
        })
        req.end()
      } catch (err) {
        log.debug(`${this.name}: warm-up ping threw`, err)
        done()
      }
    })
  }

  dispose(): void {
    if (this.warmTimer) clearInterval(this.warmTimer)
    this.warmTimer = null
    this.agent.destroy()
  }

  async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const model = request.model || this.defaultModel
    const body = JSON.stringify({
      model,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      // Per-model tuning — most importantly `reasoning_effort: 'low'` for the
      // gpt-oss family. See MODEL_PARAMS for why that is not optional.
      ...modelParams(model),
    })

    const filter = new ReasoningFilter()

    let res: IncomingMessage
    let req: ReturnType<typeof https.request>

    try {
      ;({ req, res } = await this.open(body, request.signal))
    } catch (err) {
      if (request.signal.aborted) return
      yield {
        type: 'error',
        message: (err as Error).message,
        retryable: true,
      }
      return
    }

    const status = res.statusCode ?? 0
    if (status < 200 || status >= 300) {
      const text = await readAll(res)
      yield {
        type: 'error',
        message: describeHttpError(status, text),
        retryable: RETRYABLE.has(status),
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

    try {
      for await (const chunk of res) {
        if (request.signal.aborted) return
        buffer += (chunk as Buffer).toString('utf8')

        // SSE frames are separated by a blank line, but every provider we
        // target emits one `data:` line per frame, so splitting on newline is
        // both correct here and cheaper.
        let nl: number
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue

          let parsed: ChatChunk
          try {
            parsed = JSON.parse(payload) as ChatChunk
          } catch {
            continue
          }
          if (parsed.error) {
            yield { type: 'error', message: parsed.error.message ?? 'provider error', retryable: false }
            return
          }
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? promptTokens
            completionTokens = parsed.usage.completion_tokens ?? completionTokens
          }
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) {
            const visible = filter.push(delta)
            if (visible) yield { type: 'delta', text: visible }
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
          host: this.config.host,
          path: this.config.path,
          method: 'POST',
          agent: this.agent,
          headers: { ...this.headers(), 'Content-Length': Buffer.byteLength(body) },
          timeout: 30_000,
        },
        (res) => resolve({ req, res })
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy(new Error('request timed out'))
      })
      signal.addEventListener('abort', () => req.destroy(), { once: true })
      req.end(body)
    })
  }
}

function readAll(res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    res.setEncoding('utf8')
    res.on('data', (c: string) => {
      // Enough to identify the failure without slurping a huge error page.
      if (out.length < 2048) out += c
    })
    res.on('end', () => resolve(out))
    res.on('error', () => resolve(out))
  })
}

function describeHttpError(status: number, body: string): string {
  let detail = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) detail = parsed.error.message
  } catch {
    /* keep the raw body */
  }
  if (status === 401 || status === 403) return `Authentication failed (${status}). Check the API key. ${detail}`
  if (status === 429) return `Rate limited (429). ${detail}`
  if (status === 404) return `Model or endpoint not found (404). ${detail}`
  return `Provider returned ${status}. ${detail}`
}

// ---------------------------------------------------------------------------
// Provider table — adding one of these is the whole cost of a new provider.
// ---------------------------------------------------------------------------

export const OPENAI_COMPATIBLE_PROVIDERS: Record<string, OpenAICompatibleConfig> = {
  groq: {
    name: 'groq',
    host: 'api.groq.com',
    path: '/openai/v1/chat/completions',
    warmPath: '/openai/v1/models',
    credentialKey: 'GROQ_API_KEY',
    defaultModel: 'openai/gpt-oss-20b',
    maxContextTokens: 131_072,
  },
  openrouter: {
    name: 'openrouter',
    host: 'openrouter.ai',
    path: '/api/v1/chat/completions',
    warmPath: '/api/v1/models',
    credentialKey: 'OPENROUTER_API_KEY',
    defaultModel: 'anthropic/claude-haiku-4.5',
    maxContextTokens: 200_000,
    extraHeaders: { 'X-Title': 'Cue Interview Copilot' },
  },
  openai: {
    name: 'openai',
    host: 'api.openai.com',
    path: '/v1/chat/completions',
    warmPath: '/v1/models',
    credentialKey: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
    maxContextTokens: 128_000,
  },
}

// The model catalogue and per-model tuning live in `@shared/models` so the
// renderer's picker and the request builder cannot drift apart.
export { KNOWN_MODELS, modelParams, modelsFor } from '@shared/models'
