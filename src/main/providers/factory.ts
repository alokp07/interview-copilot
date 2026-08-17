/**
 * Provider registry. Selection is config-driven — `settings.providers.llmProvider`
 * is the only thing that decides which adapter runs — so swapping a vendor is a
 * dropdown, never a code change.
 *
 * Instances are cached because they own keep-alive socket pools; throwing one
 * away between questions would discard exactly the warmth we are paying to keep.
 */

import { createLogger } from '@main/core/logger'
import type { LLMProvider } from '@main/contracts/llm'
import type { STTProvider } from '@main/contracts/stt'
import { DeepgramFluxProvider } from '@main/providers/stt/deepgram-flux'
import { AnthropicProvider } from '@main/providers/llm/anthropic'
import {
  OPENAI_COMPATIBLE_PROVIDERS,
  OpenAICompatibleProvider,
} from '@main/providers/llm/openai-compatible'

const log = createLogger('providers')

const sttCache = new Map<string, STTProvider>()
const llmCache = new Map<string, LLMProvider>()

export function listSttProviders(): string[] {
  return ['deepgram-flux']
}

export function listLlmProviders(): string[] {
  return [...Object.keys(OPENAI_COMPATIBLE_PROVIDERS), 'anthropic']
}

export function getSttProvider(name: string): STTProvider {
  const cached = sttCache.get(name)
  if (cached) return cached

  let provider: STTProvider
  switch (name) {
    case 'deepgram-flux':
      provider = new DeepgramFluxProvider()
      break
    default:
      throw new Error(
        `Unknown STT provider "${name}". Available: ${listSttProviders().join(', ')}`
      )
  }
  sttCache.set(name, provider)
  log.info(`STT provider resolved: ${name}`)
  return provider
}

export function getLlmProvider(name: string): LLMProvider {
  const cached = llmCache.get(name)
  if (cached) return cached

  let provider: LLMProvider
  if (name === 'anthropic') {
    provider = new AnthropicProvider()
  } else {
    const config = OPENAI_COMPATIBLE_PROVIDERS[name]
    if (!config) {
      throw new Error(
        `Unknown LLM provider "${name}". Available: ${listLlmProviders().join(', ')}`
      )
    }
    provider = new OpenAICompatibleProvider(config)
  }
  llmCache.set(name, provider)
  log.info(`LLM provider resolved: ${name}`)
  return provider
}

export function disposeProviders(): void {
  for (const provider of llmCache.values()) {
    ;(provider as { dispose?: () => void }).dispose?.()
  }
  llmCache.clear()
  sttCache.clear()
}
