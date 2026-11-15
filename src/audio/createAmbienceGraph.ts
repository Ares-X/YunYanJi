import type { EnvironmentSnapshot } from '../core/types';
import { generateTimberLoop, generateWindLoop } from './synthesis';
import { createWindVoicing } from './windVoicing';

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
  const voiceWind = createWindVoicing(seed);

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

  // Unequal, coprime sample lengths avoid the two air beds repeatedly aligning.
  const lowWind = loop(generateWindLoop(`${seed}:air-low`, 160001));
  const lowHighpass = filter('highpass', 55);
  const lowLowpass = filter('lowpass', 440);
  const lowGain = gain(0.13);
  const lowPan = pan(-0.3);
  lowWind.connect(lowHighpass).connect(lowLowpass).connect(lowGain).connect(lowPan).connect(volume);

  const highWind = loop(generateWindLoop(`${seed}:air-high`, 208019));
  const airHighpass = filter('highpass', 230);
  const airBand = filter('bandpass', 860, 0.48);
  const airLowpass = filter('lowpass', 2100);
  const airGain = gain(0.055);
  const airPan = pan(0.45);
  highWind.connect(airHighpass).connect(airBand).connect(airLowpass).connect(airGain).connect(airPan).connect(volume);

  const timber = loop(generateTimberLoop(`${seed}:eaves`, SYNTHESIS_SAMPLE_RATE));
  const timberHighpass = filter('highpass', 65);
  const timberFilter = filter('lowpass', 1100);
  const timberGain = gain(0.018);
  const timberPan = pan(-0.6);
  timber.connect(timberHighpass).connect(timberFilter).connect(timberGain).connect(timberPan).connect(volume);

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
      const voicing = voiceWind(frame);
      smooth(lowGain.gain, voicing.lowGain, 0.28);
      smooth(lowLowpass.frequency, voicing.lowpass, 0.3);
      smooth(airGain.gain, voicing.airGain, 0.22);
      smooth(airBand.frequency, voicing.airBand, 0.32);
      smooth(lowPan.pan, voicing.lowPan, 0.5);
      smooth(airPan.pan, voicing.airPan, 0.5);
      smooth(timberPan.pan, voicing.timberPan, 0.6);
      smooth(timberGain.gain, voicing.timberGain, 0.45);
      smooth(lowWind.playbackRate, voicing.lowRate, 0.6);
      smooth(highWind.playbackRate, voicing.airRate, 0.6);
      smooth(timber.playbackRate, voicing.timberRate, 0.8);
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
