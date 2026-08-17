/**
 * The model catalogue — pure data, shared by the main process (which sends the
 * requests) and the renderer (which draws the picker), so the two can never
 * disagree about what is selectable.
 *
 * Figures are measured on this machine, warm-connection, with the real prompt.
 */

export interface ModelChoice {
  id: string
  label: string
  note: string
}

export interface ProviderChoice {
  id: string
  label: string
  credentialKey: string
}

export const LLM_PROVIDERS: ProviderChoice[] = [
  { id: 'groq', label: 'Groq — fastest', credentialKey: 'GROQ_API_KEY' },
  { id: 'openrouter', label: 'OpenRouter — widest choice', credentialKey: 'OPENROUTER_API_KEY' },
  { id: 'openai', label: 'OpenAI', credentialKey: 'OPENAI_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', credentialKey: 'ANTHROPIC_API_KEY' },
]

/**
 * Provider catalogues move under you: Groq retired `llama-3.3-70b-versatile`
 * and `llama-3.1-8b-instant` mid-development, which is precisely why the
 * provider layer exists — recovering was a table edit, not a rewrite.
 */
export const KNOWN_MODELS: Record<string, ModelChoice[]> = {
  groq: [
    { id: 'openai/gpt-oss-20b', label: 'GPT-OSS 20B', note: '~380ms TTFT · balanced · default' },
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', note: '~465ms TTFT · best quality' },
    { id: 'groq/compound-mini', label: 'Compound Mini', note: '~1.7s TTFT · agentic, slow' },
    { id: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B', note: '~120ms TTFT · very verbose' },
  ],
  openrouter: [
    { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', note: 'fast, strong quality' },
    { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', note: 'fast, cheap' },
    { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', note: 'fast' },
  ],
  openai: [
    { id: 'gpt-4o-mini', label: 'GPT-4o mini', note: 'fast, cheap' },
    { id: 'gpt-4o', label: 'GPT-4o', note: 'higher quality, slower' },
  ],
  anthropic: [
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'fast, strong quality' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', note: 'best quality, slower' },
  ],
}

/**
 * Per-model request tuning.
 *
 * `reasoning_effort: 'low'` on the gpt-oss family is not a preference, it is
 * required for the product to work at all. Measured on Groq at default effort,
 * time-to-first-token roughly doubles (383→645 ms on 20B, 415→682 ms on 120B)
 * and — far worse — the model spends the answer's token budget on hidden
 * reasoning: one run emitted 1134 characters of scratchpad followed by a
 * truncated six-word answer. Low effort keeps reasoning to a few dozen
 * characters and leaves the answer intact.
 */
const MODEL_PARAMS: Array<{ match: RegExp; params: Record<string, unknown> }> = [
  { match: /gpt-oss/i, params: { reasoning_effort: 'low' } },
]

export function modelParams(model: string): Record<string, unknown> {
  for (const entry of MODEL_PARAMS) {
    if (entry.match.test(model)) return entry.params
  }
  return {}
}

export function modelsFor(provider: string): ModelChoice[] {
  return KNOWN_MODELS[provider] ?? []
}
