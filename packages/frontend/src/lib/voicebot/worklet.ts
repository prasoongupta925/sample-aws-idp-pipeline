// Ported from the voice web app (voice/indic-voicebot/frontend/src/audio/worklet.js).
//
// AudioWorklet processors (audio thread). Loaded with audioWorklet.addModule(); Vite bundles
// this file and dsp.ts into one script (imported with `?worker&url`).
//
//   sd-capture : microphone (device rate) -> 16 kHz PCM16 chunks -> main thread (-> WebSocket)
//                messages in: mute, stop
//   sd-playback: 16 kHz samples from the main thread -> jitter buffer -> speaker (device rate)
//                messages in: audio, clear (barge-in), drain (the bot hung up), stop
//                messages out: level, speaking, drained (the last words have been played)

import { Chunker, PlaybackQueue, Resampler, WIRE_SAMPLE_RATE } from './dsp';

// AudioWorkletGlobalScope (not in the DOM lib).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  ctor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

const LEVEL_HZ = 30; // meter updates per second

interface ProcessorOptions {
  targetRate?: number;
  chunkSamples?: number;
  sourceRate?: number;
  prebufferMs?: number;
  hangoverMs?: number;
  drainTailMs?: number;
}

function processorOptions(options?: AudioWorkletNodeOptions): ProcessorOptions {
  return ((options && options.processorOptions) || {}) as ProcessorOptions;
}

class SdCaptureProcessor extends AudioWorkletProcessor {
  private resampler: Resampler;
  private chunker: Chunker;
  private muted = false;
  private active = true;
  private levelSum = 0;
  private levelCount = 0;
  private levelEvery: number;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const o = processorOptions(options);
    this.resampler = new Resampler(
      sampleRate,
      o.targetRate || WIRE_SAMPLE_RATE,
    );
    this.chunker = new Chunker(o.chunkSamples || 1600, (pcm) => {
      this.port.postMessage({ type: 'chunk', pcm: pcm.buffer }, [pcm.buffer]);
    });
    this.levelEvery = Math.round(sampleRate / LEVEL_HZ);
    this.port.onmessage = (event: MessageEvent) => {
      const m = event.data || {};
      if (m.type === 'mute') this.muted = !!m.value;
      else if (m.type === 'stop') this.active = false;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return false;
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      for (let i = 0; i < channel.length; i++)
        this.levelSum += channel[i] * channel[i];
      this.levelCount += channel.length;
      if (this.levelCount >= this.levelEvery) {
        const level = this.muted
          ? 0
          : Math.sqrt(this.levelSum / this.levelCount);
        this.port.postMessage({ type: 'level', value: level });
        this.levelSum = 0;
        this.levelCount = 0;
      }
      this.chunker.push(this.resampler.process(channel), this.muted);
    }
    return true; // the output stays silent; it only keeps the node pulled by the graph
  }
}

class SdPlaybackProcessor extends AudioWorkletProcessor {
  private queue: PlaybackQueue;
  private speaking = false;
  private silentFrames = 0;
  private hangoverFrames: number;
  private levelSum = 0;
  private levelCount = 0;
  private levelEvery: number;
  private active = true;
  // End of call: play out the queue, then report "drained" after this much silence, so the
  // device's own output buffer (more on Bluetooth) is heard before the context closes.
  private draining = false;
  private drainSilentFrames = 0;
  private drainTailFrames: number;

  constructor(options?: AudioWorkletNodeOptions) {
    super();
    const o = processorOptions(options);
    this.queue = new PlaybackQueue(sampleRate, {
      sourceRate: o.sourceRate || WIRE_SAMPLE_RATE,
      prebufferMs: o.prebufferMs ?? 80,
    });
    this.hangoverFrames = Math.round(
      sampleRate * ((o.hangoverMs ?? 350) / 1000),
    );
    this.levelEvery = Math.round(sampleRate / LEVEL_HZ);
    this.drainTailFrames = Math.round(
      sampleRate * ((o.drainTailMs ?? 250) / 1000),
    );
    this.port.onmessage = (event: MessageEvent) => {
      const m = event.data || {};
      if (m.type === 'audio' && m.samples)
        this.queue.push(new Float32Array(m.samples));
      else if (m.type === 'clear') this.queue.clear();
      else if (m.type === 'drain') {
        this.queue.drain();
        this.draining = true;
      } else if (m.type === 'stop') this.active = false;
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (!this.active) return false;
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const real = this.queue.render(out);
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);

    for (let i = 0; i < out.length; i++) this.levelSum += out[i] * out[i];
    this.levelCount += out.length;
    if (this.levelCount >= this.levelEvery) {
      this.port.postMessage({
        type: 'level',
        value: Math.sqrt(this.levelSum / this.levelCount),
      });
      this.levelSum = 0;
      this.levelCount = 0;
    }

    if (real > 0) {
      this.silentFrames = 0;
      if (!this.speaking) {
        this.speaking = true;
        this.port.postMessage({ type: 'speaking', value: true });
      }
    } else if (this.speaking) {
      this.silentFrames += out.length;
      if (this.silentFrames >= this.hangoverFrames) {
        this.speaking = false;
        this.port.postMessage({ type: 'speaking', value: false });
      }
    }

    if (this.draining) {
      this.drainSilentFrames =
        real > 0 ? 0 : this.drainSilentFrames + out.length;
      // Already quiet when the call ended: report at once; otherwise after the tail.
      if (
        this.queue.empty &&
        (!this.speaking || this.drainSilentFrames >= this.drainTailFrames)
      ) {
        this.draining = false;
        this.port.postMessage({ type: 'drained' });
      }
    }
    return true;
  }
}

registerProcessor('sd-capture', SdCaptureProcessor);
registerProcessor('sd-playback', SdPlaybackProcessor);
