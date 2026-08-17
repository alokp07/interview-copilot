#!/usr/bin/env node
/**
 * Pre-flight check. Verifies each configured credential actually works and
 * reports which models are currently served — worth running before an
 * interview, and the fastest way to diagnose a failed session start.
 *
 * Provider catalogues change without notice (Groq retired two Llama models
 * during this project's development), so "the model I configured still exists"
 * is a real thing to check rather than assume.
 *
 * Never prints a key.
 *
 *   node --experimental-websocket scripts/probe-providers.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import https from 'node:https'

function loadEnv() {
  const env = { ...process.env }
  const path = join(process.cwd(), '.env')
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      const k = t.slice(0, eq).trim()
      if (!env[k]) env[k] = t.slice(eq + 1).trim()
    }
  }
  return env
}

const env = loadEnv()

const get = (host, path, headers) =>
  new Promise((resolve) => {
    const req = https.request({ host, path, method: 'GET', headers, timeout: 15_000 }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', (e) => resolve({ status: 0, body: e.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, body: 'timeout' })
    })
    req.end()
  })

const ok = (s) => (s ? '  OK  ' : ' FAIL ')

console.log('\nCue — provider pre-flight\n')

// --- Deepgram ---------------------------------------------------------------
const dg = env.DEEPGRAM_API_KEY
if (!dg) {
  console.log(`[${ok(false)}] Deepgram        no DEEPGRAM_API_KEY — speech recognition cannot run`)
} else {
  const res = await get('api.deepgram.com', '/v1/projects', { Authorization: `Token ${dg}` })
  const good = res.status === 200
  console.log(`[${ok(good)}] Deepgram        ${good ? 'key valid' : `HTTP ${res.status}`}`)

  if (good) {
    // Prove Flux specifically — a valid key does not guarantee model access.
    const url =
      'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16' +
      '&sample_rate=16000&eager_eot_threshold=0.4'
    const fluxOk = await new Promise((resolve) => {
      let settled = false
      const done = (v) => {
        if (!settled) {
          settled = true
          resolve(v)
        }
      }
      try {
        const ws = new WebSocket(url, { headers: { Authorization: `Token ${dg}` } })
        const timer = setTimeout(() => {
          try {
            ws.close()
          } catch {
            /* ignore */
          }
          done(false)
        }, 10_000)
        ws.addEventListener('message', (e) => {
          if (typeof e.data === 'string' && e.data.includes('"Connected"')) {
            clearTimeout(timer)
            try {
              ws.close()
            } catch {
              /* ignore */
            }
            done(true)
          }
        })
        ws.addEventListener('error', () => {
          clearTimeout(timer)
          done(false)
        })
        ws.addEventListener('close', () => done(false))
      } catch {
        done(false)
      }
    })
    console.log(
      `[${ok(fluxOk)}] Deepgram Flux   ${fluxOk ? 'v2/listen reachable, eager end-of-turn enabled' : 'could not open a Flux stream'}`
    )
  }
}

// --- LLM providers ----------------------------------------------------------
const LLM = [
  { name: 'Groq', key: 'GROQ_API_KEY', host: 'api.groq.com', path: '/openai/v1/models' },
  { name: 'OpenRouter', key: 'OPENROUTER_API_KEY', host: 'openrouter.ai', path: '/api/v1/key' },
  { name: 'OpenAI', key: 'OPENAI_API_KEY', host: 'api.openai.com', path: '/v1/models' },
]

for (const provider of LLM) {
  const key = env[provider.key]
  if (!key) {
    console.log(`[      ] ${provider.name.padEnd(15)} not configured`)
    continue
  }
  const res = await get(provider.host, provider.path, { Authorization: `Bearer ${key}` })
  const good = res.status === 200
  console.log(`[${ok(good)}] ${provider.name.padEnd(15)} ${good ? 'key valid' : `HTTP ${res.status}`}`)

  if (good && provider.name === 'Groq') {
    try {
      const ids = JSON.parse(res.body)
        .data.map((m) => m.id)
        .filter((id) => !/whisper|guard|orpheus|allam/i.test(id))
        .sort()
      console.log(`         chat models served: ${ids.join(', ')}`)
      const configured = 'openai/gpt-oss-20b'
      if (!ids.includes(configured)) {
        console.log(
          `         WARNING: the default model "${configured}" is no longer served. Pick another in Settings.`
        )
      }
    } catch {
      /* body was not the shape we expected */
    }
  }
}

// --- Anthropic --------------------------------------------------------------
if (env.ANTHROPIC_API_KEY) {
  const res = await get('api.anthropic.com', '/v1/models', {
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  })
  const good = res.status === 200
  console.log(`[${ok(good)}] ${'Anthropic'.padEnd(15)} ${good ? 'key valid' : `HTTP ${res.status}`}`)
} else {
  console.log(`[      ] ${'Anthropic'.padEnd(15)} not configured`)
}

console.log()
process.exit(0)
