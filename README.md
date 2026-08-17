# Cue — real-time AI interview copilot

Cue listens to an interview, works out when the interviewer has asked a question,
and streams a spoken-sounding answer onto a discreet overlay — typically before
the interviewer has finished the sentence.

**Measured end-to-end, live APIs, real synthesized speech:**

| | |
|---|---|
| Median answer latency | **248 ms** |
| Best | **123 ms** |
| Sub-second | **4 / 4** |

Latency is measured from *confirmed end-of-turn* (the interviewer stopped
talking) to *the first answer token on screen*. Reproduce it yourself with
`npm run bench`.

---

## How it gets there

Everything in the design serves one number, so it's worth being explicit about
where the milliseconds go and which decisions bought them.

### 1. The speech model does the turn detection

Cue is built on **Deepgram Flux** (`/v2/listen`), a turn-based conversational
model rather than a plain transcriber. It emits a state machine:

```
StartOfTurn → Update* → [EagerEndOfTurn → (TurnResumed → Update*)?] → EndOfTurn
```

`EagerEndOfTurn` fires when the model is *moderately* confident the speaker has
stopped — 150–250 ms before it is certain — and exists specifically so you can
start generating early. `TurnResumed` tells you when that guess was wrong.

That replaces the usual pile of silence timers and punctuation heuristics with a
signal from a model that was trained for it. Speech transcription rarely contains
reliable punctuation, so anything keyed on "?" is fragile by construction.

### 2. Generation starts before the question ends

On `EagerEndOfTurn` the pipeline gates the text and starts generating
immediately. Then one of three things happens:

- **`TurnResumed`** — the interviewer kept talking. Abort the request (a real
  `AbortController`, so generation actually stops rather than being ignored) and
  drop the draft.
- **`EndOfTurn`, text substantially unchanged** — *promote* the speculation. The
  answer is already streaming, so tokens landed before the question finished.
- **`EndOfTurn`, text changed** — the tail changed the question. Abort and
  regenerate from the final transcript.

A subtlety worth calling out: with a fast model a short answer often *completes*
inside that head start, so "already finished but not yet confirmed" is a normal
state the engine handles explicitly, not an edge case.

### 3. Connections are warm before the interview starts

Cold vs. warm is the single largest avoidable cost in the system:

| | cold | warm |
|---|---|---|
| Deepgram Flux connect | ~780–1400 ms | — (held open) |
| Groq first token | ~545 ms | ~150–380 ms |

Both are paid during session start-up, never on a question. The LLM adapter is
built on `node:https` with an explicit keep-alive agent plus a periodic warm-up
ping, because Node's default fetch dispatcher parks idle sockets for only ~4
seconds — with questions a minute apart, *every* answer would pay the cold price.

### 4. The question gate is local

Deciding "was that a question?" runs as regex and word lists, costing
microseconds. A small LLM classifier would cost ~115 ms and sit directly in front
of every answer — more than it could ever save in discarded generations.

The policy is deliberately asymmetric: **when unsure, answer anyway** and mark it
low-confidence. Cue only stays silent for utterances it can positively identify —
acknowledgements ("got it", "perfect thanks"), greetings, and meeting logistics
("can you hear me", "you're on mute"), which are grammatically questions but
would be worse than useless to answer. A missed question is a product failure; a
spurious answer is a bit of screen the candidate ignores.

It also handles self-correction, because interviewers restart constantly:

> "Why did you use MongoDB — actually, before that, tell me about your team."

Only the segment after the last correction marker is treated as the live
question.

### 5. Prompts stay small

The transcript is never sent wholesale. Each request is:

```
stable candidate card   (built once, marked cacheable)
+ rolling summary       (refreshed off the critical path by a cheap model)
+ last 6 turns verbatim (where contradictions actually happen)
+ the current question
```

Under ~1200 tokens regardless of interview length, with a pasted resume clipped
hard. Summarization runs strictly *after* an answer is delivered, so it can never
delay one.

---

## Architecture

```
┌─ RENDERER (React) ─ backgroundThrottling: false ───────────┐
│  getUserMedia          → mic     → CANDIDATE               │
│  getDisplayMedia+loopback → system → INTERVIEWER            │
│      ↓  AudioContext({ sampleRate: 16000 })                │
│  AudioWorklet: Float32→Int16, 80 ms frames (2560 B)        │
│      ↓  IPC (~32 KB/s per stream)                          │
│  Overlay: transcript │ question │ streaming answer          │
└────────────────────────────────────────────────────────────┘
┌─ MAIN (Node) ─ owns every secret ──────────────────────────┐
│  2× Flux WebSocket (pre-warmed, auto-reconnect)            │
│      ↓ turn events                                          │
│  TurnEngine  — speculation, promotion, cancellation, dedupe │
│      ↓                                                      │
│  ContextManager — profile + summary + recent turns          │
│      ↓                                                      │
│  LLMProvider — keep-alive pool, AbortController             │
│      ↓ deltas → IPC → UI                                    │
│  LatencyTracer — monotonic marks per turn                   │
└────────────────────────────────────────────────────────────┘
```

```
src/
  main/
    config/       credentials (OS-encrypted), settings (zod)
    contracts/    STTProvider, LLMProvider — the swap points
    providers/    stt/deepgram-flux · llm/openai-compatible · llm/anthropic
    interview/    turn-engine · question-gate · context-manager · session
    core/         logger (redacting) · trace (latency)
    windows/      overlay (always-on-top, content protection)
    ipc/          the entire renderer-reachable surface
  preload/        whitelisted contextBridge
  renderer/       audio capture + UI
  shared/         types, IPC contract, model catalogue
```

### Speaker separation

Channel-based, not diarization. The microphone is the candidate; the system
loopback is the interviewer. Two independent Flux connections, and **only the
interviewer's channel can trigger an answer** — the candidate's own voice feeds
memory so the model never contradicts what they just said out loud.

Echo cancellation is deliberately left **on** for the microphone (it subtracts
speaker output, keeping the interviewer off the candidate's channel) and **off**
for the loopback. Diarization would cost latency and money to do this worse.

### Provider swapping

`STT_PROVIDER` / `LLM_PROVIDER` are configuration, not code paths. One adapter
covers every OpenAI-compatible endpoint — Groq, OpenRouter, OpenAI, Together,
vLLM, Ollama, LM Studio — so adding a provider is a table entry. Anthropic has
its own adapter because the wire format genuinely differs and it is the only
supported provider with explicit prompt caching.

This paid for itself during development: Groq retired
`llama-3.3-70b-versatile` and `llama-3.1-8b-instant` mid-build. Recovering was a
table edit.

---

## Requirements

- **Node ≥ 20.19** (see *Known issues* if you're on an older 20.x)
- **Windows 10 2004+** for system-audio loopback and screen-capture exclusion.
  macOS/Linux run, but system audio needs extra setup (see *Platform support*).
- A **Deepgram** API key, and one LLM provider key.

## Setup

```bash
npm install
cp .env.example .env     # then fill in DEEPGRAM_API_KEY and GROQ_API_KEY
npm run dev
```

Keys can also be entered in **Settings**, where they're encrypted with the OS
keychain (DPAPI on Windows) — that takes precedence over `.env`, which is a
development convenience.

## Using it

1. Open **Profile** and paste your resume, the job description, and a few
   projects. Optional, but it's the difference between a generic answer and one
   that sounds like you. Skills are also fed to the recognizer as keyterms so it
   spells your stack correctly.
2. Pick an **interview mode** (technical, behavioral, system design, coding, HR).
3. Hit **Start**. Grant microphone access, and accept the screen-share prompt —
   that's how Windows exposes system audio. The video track is dropped
   immediately; only audio is used.
4. Both dots in the status bar should go green.

| Shortcut | |
|---|---|
| `Ctrl+Shift+Space` | Start / stop listening |
| `Ctrl+Shift+H` | Hide / show the window |
| `Ctrl+Shift+R` | Regenerate the answer |
| `Ctrl+Shift+X` | Clear the session |
| `Ctrl+Shift+O` | Cycle opacity |

The window sets `skipTaskbar`, so hiding it removes it from the taskbar and the
alt-tab list entirely. **A tray icon is the way back** — click it, or press
`Ctrl+Shift+H`. The title-bar `—` hides rather than minimises, for the same
reason: a minimised window with no taskbar button would be unreachable.

An answer shown with a purple tint is a **prediction** — generated before the
interviewer finished. It solidifies when the question is confirmed, or vanishes
if they kept talking.

## Scripts

```bash
npm run dev          # hot-reloading dev build
npm run build        # typecheck + production build
npm test             # 72 tests
npm run bench        # end-to-end latency benchmark against live APIs
npm run package:win  # NSIS installer into release/
```

### The benchmark

`npm run bench` is not a simulation. It synthesizes an interviewer's voice with
Deepgram TTS, streams it to Flux in 80 ms chunks at wall-clock pace, runs the
real turn detection and the real LLM, and reports where every millisecond went.

```
  audio streaming starts     +    0ms
  first partial transcript   +  444ms
  eager end-of-turn          + 4023ms
  LLM request sent           + 4023ms
  confirmed end-of-turn      + 4112ms
  FIRST ANSWER TOKEN         + 4403ms

  ▸ ANSWER LATENCY (end-of-turn → first token): 291ms
  ▸ speculation head start: 89ms
  ▸ LLM time-to-first-token: 380ms
```

Flags: `--no-speculative`, `--model <id>`, `--eager <0.3–0.9>`, `--rounds <n>`.
Comparing with and without `--no-speculative` shows what the speculation is
worth on your connection.

## Grounded answers

The best answer is not the best answer to the question — it is the best answer
*this candidate could plausibly give*. An answer that name-drops Cassandra to
someone who has never heard of it collapses at the first follow-up, which is
worse than a plainer answer they own. Cue enforces that principle; competitors
personalize from a resume, but none of them enforce a knowledge boundary.

**Ground answers in my profile** (Profile tab, on by default) constrains every
answer to what the profile supports:

- Only claims hands-on experience with technologies in your skills list — the
  boundary is your literal toolkit, spelled out to the model.
- Never names a technology outside it *unless the interviewer named it first*
  ("have you used Kafka?" still gets a Kafka answer).
- Questions beyond your toolkit get the honest bridge: one clause admitting
  limited hands-on exposure, one correct sentence about the concept, then the
  problem worked from things you actually know. Live-verified — a fresher
  profile asked to design a 100k-rps URL shortener answered with JavaScript
  hash maps and its own to-do-app localStorage experience, closing with *"those
  are beyond my current toolkit"* instead of reciting Redis clusters.
- A tense rule applies in **every** mode: what you *would* do is always fair
  game, what you claim to *have* done requires profile backing.

**Answer complexity** (Simple / Balanced / Advanced) sets the register — plain
practitioner language through senior-engineer tradeoffs-and-numbers. And when
an answer still lands wrong mid-interview, the **simpler / deeper** buttons on
the answer rewrite it in one click; no settings dive during a live call.

Turn grounding off for unconstrained best-possible answers. One documented
limitation: ungrounded mode with a *completely empty* profile may still invent
experience ("in a recent project we…") despite prompt-side bans — a small model
completes the candidate persona with fiction when it has nothing true to cite.
Grounding (the default) does not have this problem, which is why it is the
default. Verify the behaviour yourself against the live model:

```powershell
$env:LIVE='1'; npx vitest run tests/grounding-live.test.ts
# answers land in grounding-live.log for reading
```

The profile that powers this is **persisted encrypted on this device** (DPAPI
via `safeStorage`, the same mechanism as API keys) and loaded at launch — no
more re-typing it every session. It never leaves the machine; **Clear** +
Apply deletes the encrypted file. **Auto-fill from resume** extracts skills,
projects, education and work history from pasted resume text into any fields
you left blank (your own entries are never overwritten), using the same
provider off the answer path.

Grounded generations also run at lower sampling temperature (0.35 vs 0.5) —
constraint adherence improves and the voice survives fine.

## Tuning latency

**Prediction threshold** (Settings, default 0.4) trades discarded work for head
start. Lower fires sooner with more false starts; Deepgram's guidance is that
0.3–0.5 buys 150–250 ms at the cost of 50–70% more LLM calls.

**Model choice**, measured warm on this machine:

| Model | TTFT | Notes |
|---|---|---|
| `openai/gpt-oss-20b` | ~380 ms | Default. Good quality, grounded answers |
| `openai/gpt-oss-120b` | ~465 ms | Best quality |
| `groq/compound-mini` | ~1.7 s | Agentic; too slow for live use |
| `qwen/qwen3.6-27b` | ~120 ms | Fastest, but very verbose |

> **gpt-oss requires `reasoning_effort: 'low'`** and Cue sets it automatically.
> At default effort TTFT roughly doubles and the model spends the answer's token
> budget on hidden reasoning — one benchmark run produced 1134 characters of
> scratchpad followed by a truncated six-word answer.

Some models emit `<think>` blocks inline in their output; those are stripped from
the stream before anything reaches the screen.

## Privacy and security

- **API keys** are encrypted at rest with `safeStorage` (DPAPI on Windows) and
  never leave the main process. The renderer has no access to them and no network
  permission of its own — its CSP allows `connect-src 'self'` only.
- **The resume and job description are memory-only.** They are never written to
  disk and are wiped on quit.
- **No audio is stored.** Frames are converted, sent, and discarded.
- **Transcripts are memory-only**, capped, and cleared with `Ctrl+Shift+X`.
- **Logs are redacted** — every value passes through a redactor that strips
  registered secrets and anything matching common key formats, so a key cannot
  reach a log line even by accident.
- Exported latency traces contain **timings only**, never question or answer text.

## Platform support

| | Microphone | System audio | Hidden from screen share |
|---|---|---|---|
| **Windows 10 2004+** | ✅ | ✅ WASAPI loopback | ✅ `WDA_EXCLUDEFROMCAPTURE` |
| macOS 14.2+ | ✅ | ⚠️ CoreAudio Tap; needs entitlement | ⚠️ partial |
| Linux | ✅ | ⚠️ PipeWire-dependent | ⚠️ compositor-dependent |

Windows is the supported target. The audio layer is abstracted behind
`AudioCapture`, so other platforms are a capture-backend change rather than a
redesign.

## Failure handling

| Failure | Behaviour |
|---|---|
| Network drop | Flux reconnects with backoff (250 ms → 8 s); up to 2 s of audio buffered, oldest dropped first |
| LLM transient error | One retry, but only before any token has shipped, so answers never restart mid-sentence |
| Rate limit / auth failure | Surfaced in the UI with the provider's own message |
| Microphone unavailable | Session continues on system audio alone, with a warning |
| System audio unavailable | Warns that the interviewer won't be heard |
| Interviewer interrupts | Generation aborted, draft dropped |
| Duplicate question | Suppressed for 90 s via token-overlap similarity |
| Summarizer fails | Logged; the previous summary is kept and answers are unaffected |

## Working on the interface

The overlay sets content protection, so **it cannot be screenshotted** — which
makes designing it awkward. Opening the renderer directly in a browser solves
that: with no preload bridge present, a development-only stand-in is installed
(`src/renderer/src/lib/dev-bridge.ts`) that supplies representative data.

```
npm run dev
# then, in any browser:
http://localhost:5173/?demo=1          # replays a question and streams an answer
http://localhost:5173/?view=settings   # jump straight to a tab
```

The stub is stripped from production builds by an `import.meta.env.DEV` guard.

## Known issues

**Node 20.16 and older 20.x break two things**, both for the same reason: those
versions cannot `require()` an ESM module (`require(esm)` arrived in Node 20.19),
and two build-time dependencies still do exactly that.

1. **Installing Electron.** Its postinstall `require()`s the ESM-only
   `@electron/get`, and the failure surfaces later as the unhelpful
   `Error: Electron uninstall`. Worked around by `scripts/install-electron.mjs`,
   which runs automatically as a `postinstall`.
2. **Building the NSIS installer.** `app-builder-lib` `require()`s
   `@noble/hashes/blake2.js` while generating the update blockmap, so
   `npm run package:win` fails. `npm run package:dir` still works and produces a
   runnable app folder — it just skips the installer.

**Upgrading to Node 22 LTS fixes both**, after which `scripts/install-electron.mjs`
can be deleted and `package:win` works normally.

## What isn't built yet

Deliberately out of scope for this version: accounts, billing tiers, usage
limits, cloud sync, and interview history. The architecture leaves room for them
— sessions, profiles and traces are already separable — but the core loop came
first.

Also not yet done: an STT provider other than Deepgram. The `STTProvider`
contract is designed for it (providers without native turn detection declare
`nativeTurnDetection: false` and synthesize turn events), but only the Flux
adapter is implemented, since it is the one that makes the latency target
reachable.
