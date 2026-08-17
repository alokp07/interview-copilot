#!/usr/bin/env node
/**
 * End-to-end latency benchmark.
 *
 * This is not a simulation with stubbed timings — it runs the real pipeline:
 *
 *   Deepgram TTS  → synthesize an interviewer asking a question
 *        ↓          (real speech, so Flux's turn detector has real signal)
 *   Flux WebSocket → streamed in 80 ms chunks at wall-clock pace
 *        ↓
 *   turn events   → EagerEndOfTurn / EndOfTurn
 *        ↓
 *   Groq          → streamed answer
 *
 * and reports where every millisecond went. The headline figure is
 * `EndOfTurn → first answer token`, which is negative whenever speculation wins.
 *
 * Usage:
 *   node --experimental-websocket scripts/bench-latency.mjs
 *   node --experimental-websocket scripts/bench-latency.mjs --no-speculative
 *   node --experimental-websocket scripts/bench-latency.mjs --model llama-3.1-8b-instant
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import https from 'node:https'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback
}

const SPECULATIVE = !flag('no-speculative')
const MODEL = opt('model', 'openai/gpt-oss-20b')
// gpt-oss burns its whole answer budget on hidden reasoning at default effort.
const MODEL_EXTRA = /gpt-oss/i.test(MODEL) ? { reasoning_effort: 'low' } : {}
const EAGER_THRESHOLD = Number(opt('eager', '0.4'))
const ROUNDS = Number(opt('rounds', '1'))

const QUESTIONS = [
  'So, why did you choose MongoDB for that project instead of Postgres?',
  'Can you walk me through how React reconciliation actually works?',
  "Let's say we need to design a URL shortener that handles a hundred thousand requests per second. How would you approach it?",
  'Tell me about a time you disagreed with a technical decision on your team.',
]

const SAMPLE_RATE = 16000
const FRAME_SAMPLES = 1280 // 80 ms
const FRAME_BYTES = FRAME_SAMPLES * 2

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function loadEnv() {
  const path = join(process.cwd(), '.env')
  const env = { ...process.env }
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
const DEEPGRAM_KEY = env.DEEPGRAM_API_KEY
const GROQ_KEY = env.GROQ_API_KEY

if (!DEEPGRAM_KEY || !GROQ_KEY) {
  console.error('DEEPGRAM_API_KEY and GROQ_API_KEY must be set (in .env or the environment).')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = () => performance.now()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ms = (v) => `${v >= 0 ? '' : '−'}${Math.abs(Math.round(v))}ms`

/** Synthesize the interviewer's voice so Flux sees genuine speech. */
function synthesize(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text })
    const req = https.request(
      {
        host: 'api.deepgram.com',
        path: `/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=${SAMPLE_RATE}&container=none`,
        method: 'POST',
        headers: {
          Authorization: `Token ${DEEPGRAM_KEY}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          if (res.statusCode !== 200) {
            reject(new Error(`TTS ${res.statusCode}: ${buf.toString('utf8').slice(0, 200)}`))
            return
          }
          resolve(buf)
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('TTS timed out')))
    req.end(body)
  })
}

const agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 5000, maxSockets: 4 })

function warmGroq() {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: 'api.groq.com',
        path: '/openai/v1/models',
        method: 'GET',
        agent,
        headers: { Authorization: `Bearer ${GROQ_KEY}` },
        timeout: 8000,
      },
      (res) => {
        res.resume()
        res.on('end', resolve)
      }
    )
    req.on('error', resolve)
    req.on('timeout', () => {
      req.destroy()
      resolve()
    })
    req.end()
  })
}

/** Streams an answer, resolving with timings. */
function generate(question, onFirstToken) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      stream: true,
      max_tokens: 260,
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content:
            'You are a live interview copilot. Output ONLY the words the candidate should say out loud, as the candidate. ' +
            'First person, spoken English, 45-90 words. No preamble, no markdown.',
        },
        {
          role: 'system',
          content:
            'Candidate profile:\nRole: Full-stack engineer\nSkills: React, Node.js, Python, MongoDB, AI systems\n' +
            'Projects: AI visual novel app; PDF-to-podcast pipeline',
        },
        { role: 'user', content: question },
      ],
      ...MODEL_EXTRA,
    })

    const sentAt = now()
    let firstAt = null
    let text = ''

    const req = https.request(
      {
        host: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        agent,
        headers: {
          Authorization: `Bearer ${GROQ_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30_000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          let err = ''
          res.on('data', (c) => (err += c))
          res.on('end', () => reject(new Error(`LLM ${res.statusCode}: ${err.slice(0, 200)}`)))
          return
        }
        let buffer = ''
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8')
          let nl
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (!payload || payload === '[DONE]') continue
            try {
              const delta = JSON.parse(payload).choices?.[0]?.delta?.content
              if (delta) {
                if (firstAt === null) {
                  firstAt = now()
                  onFirstToken?.(firstAt)
                }
                text += delta
              }
            } catch {
              /* ignore keepalive frames */
            }
          }
        })
        res.on('end', () => resolve({ sentAt, firstAt, doneAt: now(), text }))
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('LLM timed out')))
    req.end(body)
  })
}

// ---------------------------------------------------------------------------
// One measured question
// ---------------------------------------------------------------------------

async function runOne(question) {
  const audio = await synthesize(question)
  const audioSeconds = audio.length / 2 / SAMPLE_RATE

  const url =
    'wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16' +
    `&sample_rate=${SAMPLE_RATE}&eot_threshold=0.7&eot_timeout_ms=4000` +
    (SPECULATIVE ? `&eager_eot_threshold=${EAGER_THRESHOLD}` : '')

  const marks = {}
  let generation = null
  let eagerTranscript = ''
  let finalTranscript = ''
  let resolveDone
  const done = new Promise((r) => (resolveDone = r))

  const connectStart = now()
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${DEEPGRAM_KEY}` } })

  ws.addEventListener('open', () => {
    marks.connected = now()
  })

  ws.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string') return
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return
    }
    if (msg.type !== 'TurnInfo') return

    const at = now()
    if (msg.event === 'StartOfTurn') marks.speechStart ??= at
    if (msg.event === 'Update') marks.firstPartial ??= at

    if (msg.event === 'EagerEndOfTurn') {
      marks.eagerEnd ??= at
      eagerTranscript = msg.transcript ?? ''
      if (!generation) {
        marks.llmRequest = now()
        generation = generate(eagerTranscript, (t) => (marks.firstToken ??= t)).catch((e) => ({
          error: e,
        }))
      }
    }

    if (msg.event === 'TurnResumed') {
      marks.resumed ??= at
    }

    if (msg.event === 'EndOfTurn') {
      marks.endOfTurn ??= at
      finalTranscript = msg.transcript ?? ''
      if (!generation) {
        marks.llmRequest = now()
        generation = generate(finalTranscript, (t) => (marks.firstToken ??= t)).catch((e) => ({
          error: e,
        }))
      }
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }))
      } catch {
        /* already closing */
      }
      resolveDone()
    }
  })

  ws.addEventListener('error', () => resolveDone())
  ws.addEventListener('close', () => resolveDone())

  // Wait for the socket, then stream the audio at real-time pace so the turn
  // detector sees the same cadence it would in a live call.
  await new Promise((resolve) => {
    if (ws.readyState === 1) resolve()
    else ws.addEventListener('open', resolve, { once: true })
  })

  marks.audioStart = now()
  for (let offset = 0; offset < audio.length; offset += FRAME_BYTES) {
    if (ws.readyState !== 1) break
    const slice = audio.subarray(offset, Math.min(offset + FRAME_BYTES, audio.length))
    ws.send(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength))
    await sleep(80)
  }
  marks.audioEnd = now()

  // Flux needs trailing silence to be sure the turn ended.
  const silence = Buffer.alloc(FRAME_BYTES)
  const deadline = now() + 5000
  while (!marks.endOfTurn && now() < deadline && ws.readyState === 1) {
    ws.send(silence.buffer.slice(0))
    await sleep(80)
  }

  await Promise.race([done, sleep(6000)])
  const result = generation ? await generation : null
  try {
    ws.close()
  } catch {
    /* ignore */
  }

  return {
    question,
    audioSeconds,
    connectMs: marks.connected - connectStart,
    marks,
    result,
    eagerTranscript,
    finalTranscript,
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function report(run) {
  const { marks, result } = run
  const base = marks.audioStart

  console.log(`\n${'─'.repeat(76)}`)
  console.log(`Q: ${run.question}`)
  console.log(`   ${run.audioSeconds.toFixed(1)}s of synthesized speech\n`)

  const rows = [
    ['audio streaming starts', marks.audioStart],
    ['first partial transcript', marks.firstPartial],
    ['audio streaming ends', marks.audioEnd],
    ['eager end-of-turn', marks.eagerEnd],
    ['turn resumed', marks.resumed],
    ['LLM request sent', marks.llmRequest],
    ['confirmed end-of-turn', marks.endOfTurn],
    ['FIRST ANSWER TOKEN', marks.firstToken],
    ['generation complete', result?.doneAt],
  ]

  for (const [label, at] of rows) {
    if (at === undefined || at === null) continue
    console.log(`  ${label.padEnd(26)} +${String(Math.round(at - base)).padStart(5)}ms`)
  }

  console.log()
  if (marks.endOfTurn && marks.firstToken) {
    const answerLatency = marks.firstToken - marks.endOfTurn
    const verdict =
      answerLatency < 0
        ? 'answer was already on screen before the question ended'
        : answerLatency < 1000
          ? 'sub-second'
          : 'over a second'
    console.log(`  ▸ ANSWER LATENCY (end-of-turn → first token): ${ms(answerLatency)}  — ${verdict}`)
  }
  if (marks.eagerEnd && marks.endOfTurn) {
    console.log(`  ▸ speculation head start: ${ms(marks.endOfTurn - marks.eagerEnd)}`)
  }
  if (marks.llmRequest && marks.firstToken) {
    console.log(`  ▸ LLM time-to-first-token: ${ms(marks.firstToken - marks.llmRequest)}`)
  }
  if (result?.doneAt && marks.endOfTurn) {
    console.log(`  ▸ full answer delivered: ${ms(result.doneAt - marks.endOfTurn)} after end-of-turn`)
  }
  console.log(`  ▸ Flux connect (paid once, at session start): ${ms(run.connectMs)}`)

  if (run.eagerTranscript && run.finalTranscript && run.eagerTranscript !== run.finalTranscript) {
    console.log(`\n  eager heard : "${run.eagerTranscript}"`)
    console.log(`  final heard : "${run.finalTranscript}"`)
  }
  if (result?.text) {
    console.log(`\n  Answer: ${result.text.trim()}`)
  }
  if (result?.error) {
    console.log(`\n  LLM ERROR: ${result.error.message}`)
  }
}

// ---------------------------------------------------------------------------

console.log(`
Cue — end-to-end latency benchmark
  speculation : ${SPECULATIVE ? `on (eager_eot_threshold=${EAGER_THRESHOLD})` : 'off'}
  model       : ${MODEL}
  pipeline    : Deepgram TTS → Flux (v2/listen) → question gate → Groq → tokens
`)

// Warm the LLM connection exactly as the app does at session start; otherwise
// the first measurement includes ~400ms of TLS setup the product never pays.
await warmGroq()

const latencies = []
for (let round = 0; round < ROUNDS; round++) {
  for (const question of QUESTIONS) {
    try {
      const run = await runOne(question)
      report(run)
      if (run.marks.endOfTurn && run.marks.firstToken) {
        latencies.push(run.marks.firstToken - run.marks.endOfTurn)
      }
    } catch (err) {
      console.error(`\n  FAILED: ${err.message}`)
    }
  }
}

if (latencies.length > 0) {
  const sorted = [...latencies].sort((a, b) => a - b)
  const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length
  console.log(`\n${'═'.repeat(76)}`)
  console.log('SUMMARY — end-of-turn → first answer token')
  console.log(`  n      : ${latencies.length}`)
  console.log(`  best   : ${ms(sorted[0])}`)
  console.log(`  median : ${ms(sorted[Math.floor(sorted.length / 2)])}`)
  console.log(`  worst  : ${ms(sorted[sorted.length - 1])}`)
  console.log(`  mean   : ${ms(mean)}`)
  console.log(`  under 1s: ${latencies.filter((v) => v < 1000).length}/${latencies.length}`)
  console.log(`${'═'.repeat(76)}\n`)
}

process.exit(0)
