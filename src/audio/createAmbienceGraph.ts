import type { EnvironmentSnapshot } from '../core/types';
import { generateTimberLoop, generateWindLoop } from './synthesis';

export interface AmbienceGraph {
  update(frame: EnvironmentSnapshot): void;
  setVolume(volume: number): void;
  setActive(active: boolean): void;
  dispose(): void;
  readonly sourceCount: number;
}

const SYNTHESIS_SAMPLE_RATE = 16000;

/** Works with AudioContext and OfflineAudioContext, including deterministic QA. */
export function createAmbienceGraph(context: BaseAudioContext, seed: string): AmbienceGraph {
  const nodes: AudioNode[] = [];
  const sources: AudioBufferSourceNode[] = [];
  let disposed = false;
  let nextWeatherUpdate = -1;
  let active = false;

  function own<T extends AudioNode>(node: T): T {
    nodes.push(node);
    return node;
  }

  function loop(samples: Float32Array): AudioBufferSourceNode {
    const buffer = context.createBuffer(1, samples.length, SYNTHESIS_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = own(context.createBufferSource());
    source.buffer = buffer;
    source.loop = true;
    sources.push(source);
    return source;
  }

  function filter(type: BiquadFilterType, frequency: number, q = 0.7): BiquadFilterNode {
    const node = own(context.createBiquadFilter());
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = q;
    return node;
  }

  function gain(value: number): GainNode {
    const node = own(context.createGain());
    node.gain.value = value;
    return node;
  }

  function pan(value: number): StereoPannerNode {
    const node = own(context.createStereoPanner());
    node.pan.value = value;
    return node;
  }

  const volume = gain(0.45);
  const gate = gain(0);
  const limiter = own(context.createDynamicsCompressor());
  limiter.threshold.value = -18;
  limiter.knee.value = 12;
  limiter.ratio.value = 4;
  limiter.attack.value = 0.008;
  limiter.release.value = 0.3;
  volume.connect(limiter);
  limiter.connect(gate);
  gate.connect(context.destination);

  const lowWind = loop(generateWindLoop(`${seed}:air-low`, SYNTHESIS_SAMPLE_RATE * 7));
  const lowHighpass = filter('highpass', 55);
  const lowLowpass = filter('lowpass', 440);
  const lowGain = gain(0.13);
  const lowPan = pan(-0.3);
  lowWind.connect(lowHighpass).connect(lowLowpass).connect(lowGain).connect(lowPan).connect(volume);

  const highWind = loop(generateWindLoop(`${seed}:air-high`, SYNTHESIS_SAMPLE_RATE * 9));
  const airHighpass = filter('highpass', 230);
  const airBand = filter('bandpass', 860, 0.48);
  const airLowpass = filter('lowpass', 2100);
  const airGain = gain(0.055);
  const airPan = pan(0.45);
  highWind.connect(airHighpass).connect(airBand).connect(airLowpass).connect(airGain).connect(airPan).connect(volume);

  const timber = loop(generateTimberLoop(`${seed}:eaves`, SYNTHESIS_SAMPLE_RATE));
  const timberFilter = filter('lowpass', 1100);
  const timberGain = gain(0.018);
  const timberPan = pan(-0.6);
  timber.connect(timberFilter).connect(timberGain).connect(timberPan).connect(volume);

  for (const source of sources) source.start(context.currentTime);

  function smooth(parameter: AudioParam, value: number, timeConstant: number): void {
    parameter.cancelScheduledValues(context.currentTime);
    parameter.setTargetAtTime(value, context.currentTime, timeConstant);
  }

  return {
    sourceCount: sources.length,
    update(frame) {
      if (disposed || context.currentTime < nextWeatherUpdate) return;
      // Bound automation to 20 Hz; no nodes or sample buffers are created here.
      nextWeatherUpdate = context.currentTime + 0.05;
      const strength = Math.min(1, Math.max(0, frame.wind.strength));
      const gust = Math.min(1, Math.max(0, frame.gust));
      const direction = Math.max(-1, Math.min(1, frame.wind.x * 0.18));
      smooth(lowGain.gain, 0.095 + strength * 0.19 + gust * 0.035, 0.28);
      smooth(lowLowpass.frequency, 320 + strength * 430, 0.3);
      smooth(airGain.gain, 0.025 + strength * 0.1 + gust * 0.04, 0.22);
      smooth(airBand.frequency, 580 + strength * 610, 0.32);
      smooth(lowPan.pan, -0.28 + direction * 0.2, 0.5);
      smooth(airPan.pan, 0.4 + direction * 0.22, 0.5);
      smooth(timberGain.gain, 0.01 + strength * 0.025 + gust * 0.014, 0.45);
    },
    setVolume(value) {
      if (disposed) return;
      const safeVolume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      smooth(volume.gain, safeVolume, 0.08);
    },
    setActive(value) {
      if (disposed || active === value) return;
      active = value;
      smooth(gate.gain, value ? 1 : 0, value ? 0.14 : 0.025);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gate.gain.cancelScheduledValues(context.currentTime);
      gate.gain.value = 0;
      for (const source of sources) {
        source.stop();
        source.buffer = null;
      }
      for (const node of nodes) node.disconnect();
      sources.length = 0;
      nodes.length = 0;
    },
  };
}
