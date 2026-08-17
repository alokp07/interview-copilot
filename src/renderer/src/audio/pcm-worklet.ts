/**
 * The PCM encoder worklet, kept as a string and loaded from a Blob URL.
 *
 * Inlining it avoids any dependency on how the bundler emits assets, which is
 * the usual source of "works in dev, 404s in the packaged app" bugs with
 * `audioWorklet.addModule`.
 *
 * The work itself runs on the real-time audio thread, so the renderer's main
 * thread never touches raw samples: it only ever receives a finished 2560-byte
 * frame, transferred rather than copied.
 *
 * The AudioContext is created at 16 kHz, so Chromium resamples upstream for us
 * and a render quantum is 128 samples — exactly 10 quanta per 80 ms frame.
 */

export const PCM_WORKLET_SOURCE = /* js */ `
const FRAME_SAMPLES = 1280; // 80ms @ 16kHz

class PCMEncoder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i];
      if (this.filled === FRAME_SAMPLES) {
        const pcm = new Int16Array(FRAME_SAMPLES);
        let energy = 0;
        for (let j = 0; j < FRAME_SAMPLES; j++) {
          let s = this.buffer[j];
          if (s > 1) s = 1; else if (s < -1) s = -1;
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
          energy += s * s;
        }
        // Transfer the buffer so the frame crosses threads without a copy.
        this.port.postMessage(
          { frame: pcm.buffer, rms: Math.sqrt(energy / FRAME_SAMPLES) },
          [pcm.buffer]
        );
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-encoder', PCMEncoder);
`

let cachedUrl: string | null = null

export function pcmWorkletUrl(): string {
  if (cachedUrl) return cachedUrl
  cachedUrl = URL.createObjectURL(
    new Blob([PCM_WORKLET_SOURCE], { type: 'application/javascript' })
  )
  return cachedUrl
}
