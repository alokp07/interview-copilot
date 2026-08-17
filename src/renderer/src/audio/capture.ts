/**
 * Audio capture — two independent channels, one AudioContext.
 *
 * Speaker attribution comes from the channel, not from diarization:
 *
 *   • `system` — Chromium's WASAPI loopback via `getDisplayMedia`. Everything
 *     the meeting app plays through the speakers, i.e. the interviewer. Works
 *     for Meet, Zoom, Teams and anything else, because it taps the OS mixer
 *     rather than the app.
 *   • `mic` — the candidate. Echo cancellation is deliberately left *on* here:
 *     it subtracts the speaker output from the microphone signal, which is
 *     exactly the bleed that would otherwise make the interviewer's voice show
 *     up on the candidate's channel.
 *
 * Diarization would cost latency and money to do worse.
 */

import type { StreamId } from '@shared/types'
import { AUDIO } from '@shared/types'
import { pcmWorkletUrl } from './pcm-worklet'

export type CaptureStateListener = (
  stream: StreamId,
  state: 'requesting' | 'live' | 'denied' | 'unavailable' | 'error' | 'idle',
  error?: string
) => void

export type LevelListener = (stream: StreamId, level: number) => void

interface Channel {
  mediaStream: MediaStream
  source: MediaStreamAudioSourceNode
  node: AudioWorkletNode
  sink: GainNode
}

export class AudioCapture {
  private ctx: AudioContext | null = null
  private channels = new Map<StreamId, Channel>()
  private workletReady: Promise<void> | null = null

  constructor(
    private readonly onFrame: (stream: StreamId, frame: ArrayBuffer) => void,
    private readonly onState: CaptureStateListener,
    private readonly onLevel: LevelListener
  ) {}

  private async context(): Promise<AudioContext> {
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') await this.ctx.resume()
      return this.ctx
    }
    // Asking for 16 kHz directly makes Chromium resample in the audio graph, so
    // we never write a resampler and never pay for one on the main thread.
    this.ctx = new AudioContext({ sampleRate: AUDIO.sampleRate, latencyHint: 'interactive' })
    try {
      this.workletReady = this.ctx.audioWorklet.addModule(pcmWorkletUrl())
      await this.workletReady
    } catch (err) {
      // Both channels share this context, so a worklet failure takes out all
      // capture at once. Name it explicitly rather than letting it surface as a
      // generic per-device error, which reads like a microphone problem.
      this.workletReady = null
      throw new Error(
        `Audio worklet failed to load (${(err as Error).message}). ` +
          'This is usually the renderer CSP blocking the blob: script source.'
      )
    }
    return this.ctx
  }

  /** Interviewer channel: system/meeting audio. */
  async startSystem(): Promise<boolean> {
    this.onState('system', 'requesting')
    try {
      // `video: true` is required for the request to be valid; main returns a
      // screen source plus `audio: 'loopback'`. We drop the video immediately —
      // decoding frames we never look at would cost real CPU.
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })

      for (const track of stream.getVideoTracks()) {
        track.stop()
        stream.removeTrack(track)
      }

      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop())
        this.onState(
          'system',
          'unavailable',
          'No system audio track was returned. On Windows this usually means no audio device is active.'
        )
        return false
      }

      await this.attach('system', stream)
      return true
    } catch (err) {
      const message = (err as Error).message || String(err)
      const denied = /denied|dismissed|NotAllowed/i.test(message)
      this.onState('system', denied ? 'denied' : 'error', message)
      return false
    }
  }

  /** Candidate channel: microphone. */
  async startMic(): Promise<boolean> {
    this.onState('mic', 'requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // On for the microphone specifically: this is what keeps the
          // interviewer's voice off the candidate's channel.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      await this.attach('mic', stream)
      return true
    } catch (err) {
      const message = (err as Error).message || String(err)
      const denied = /denied|NotAllowed|Permission/i.test(message)
      const missing = /NotFound|DevicesNotFound/i.test(message)
      this.onState('mic', denied ? 'denied' : missing ? 'unavailable' : 'error', message)
      return false
    }
  }

  private async attach(id: StreamId, mediaStream: MediaStream): Promise<void> {
    const ctx = await this.context()
    this.stop(id)

    const source = ctx.createMediaStreamSource(mediaStream)
    const node = new AudioWorkletNode(ctx, 'pcm-encoder', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })

    let lastLevelAt = 0
    node.port.onmessage = (event: MessageEvent<{ frame: ArrayBuffer; rms: number }>) => {
      this.onFrame(id, event.data.frame)
      // Throttle the meter: it is decoration, and it must not compete with the
      // audio path for main-thread time.
      const at = performance.now()
      if (at - lastLevelAt > 100) {
        lastLevelAt = at
        this.onLevel(id, Math.min(1, event.data.rms * 4))
      }
    }

    // A Web Audio node is only pulled if it reaches the destination, so route
    // through a silent gain rather than leaving the graph dangling — connecting
    // straight to the output would echo the interviewer back into the room.
    const sink = ctx.createGain()
    sink.gain.value = 0
    source.connect(node)
    node.connect(sink)
    sink.connect(ctx.destination)

    // The user can revoke sharing from the OS/browser UI at any time.
    for (const track of mediaStream.getAudioTracks()) {
      track.addEventListener('ended', () => {
        this.stop(id)
        this.onState(id, 'idle', 'The audio source stopped.')
      })
    }

    this.channels.set(id, { mediaStream, source, node, sink })
    this.onState(id, 'live')
  }

  stop(id: StreamId): void {
    const channel = this.channels.get(id)
    if (!channel) return
    this.channels.delete(id)
    channel.node.port.onmessage = null
    try {
      channel.source.disconnect()
      channel.node.disconnect()
      channel.sink.disconnect()
    } catch {
      /* already torn down */
    }
    for (const track of channel.mediaStream.getTracks()) track.stop()
  }

  stopAll(): void {
    for (const id of [...this.channels.keys()]) this.stop(id)
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.workletReady = null
    this.onState('system', 'idle')
    this.onState('mic', 'idle')
  }

  isLive(id: StreamId): boolean {
    return this.channels.has(id)
  }
}
