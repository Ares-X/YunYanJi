import type { EnvironmentSnapshot } from '../core/types';
import {
  generateEmberLoop, generateFireCrackleLoop, generateRainDropsLoop, generateRainLoop, generateWindLoop,
} from './synthesis';
import { createRainfireVoicing } from './rainfireVoicing';

export interface AmbienceGraph {
  update(frame: EnvironmentSnapshot): void;
  setVolume(volume: number): void;
  setActive(active: boolean): void;
  dispose(): void;
  readonly sourceCount: number;
}

export const SYNTHESIS_SAMPLE_RATE = 24000;

/** Every sample is synthesized once. Eight reusable voices need no timers/nodes per event. */
export function createAmbienceGraph(context: BaseAudioContext, seed: string): AmbienceGraph {
  const nodes: AudioNode[] = [];
  const sources: AudioBufferSourceNode[] = [];
  let disposed = false;
  let nextWeatherUpdate = -1;
  let latestFrame: EnvironmentSnapshot | null = null;
  let lastPrecipitation = Number.NaN;
  let active = false;
  const voiceWeather = createRainfireVoicing(seed);

  function own<T extends AudioNode>(node: T): T { nodes.push(node); return node; }
  function gain(value: number): GainNode {
    const node = own(context.createGain());
    node.gain.value = value;
    return node;
  }

  const volume = gain(0.45), gate = gain(0);
  const limiter = own(context.createDynamicsCompressor());
  limiter.threshold.value = -13;
  limiter.knee.value = 6;
  limiter.ratio.value = 3;
  limiter.attack.value = 0.006;
  limiter.release.value = 0.25;
  volume.connect(limiter).connect(gate).connect(context.destination);

  function layer(samples: Float32Array, level: number, position: number) {
    const buffer = context.createBuffer(1, samples.length, SYNTHESIS_SAMPLE_RATE);
    buffer.getChannelData(0).set(samples);
    const source = own(context.createBufferSource());
    source.buffer = buffer;
    source.loop = true;
    sources.push(source);
    const amplitude = gain(level);
    const pan = own(context.createStereoPanner());
    pan.pan.value = position;
    source.connect(amplitude).connect(pan).connect(volume);
    return { source, amplitude: amplitude.gain, pan: pan.pan };
  }

  // Different lengths and seeds avoid a repeated stereo swell or a common seam.
  const low = layer(generateWindLoop(`${seed}:air-low`, 240007), 0.11, -0.24);
  const air = layer(generateWindLoop(`${seed}:air-high`, 312019), 0.045, 0.30);
  const rainLeft = layer(generateRainLoop(`${seed}:distant-rain-left`, 384017), 0.26, -0.68);
  const rainRight = layer(generateRainLoop(`${seed}:distant-rain-right`, 456043), 0.24, 0.66);
  const drops = layer(generateRainDropsLoop(`${seed}:wet-stone`, SYNTHESIS_SAMPLE_RATE, 29.53, 'stone'), 0.08, 0.26);
  const roof = layer(generateRainDropsLoop(`${seed}:shelter-edge`, SYNTHESIS_SAMPLE_RATE, 37.19, 'shelter'), 0.065, -0.38);
  const fire = layer(generateFireCrackleLoop(`${seed}:close-fire`, SYNTHESIS_SAMPLE_RATE), 0.26, -0.13);
  const embers = layer(generateEmberLoop(`${seed}:fire-breath`, 408023), 0.028, -0.13);
  for (const source of sources) source.start(context.currentTime);

  function smooth(parameter: AudioParam, value: number, timeConstant: number, settleSilence = false): void {
    parameter.cancelScheduledValues(context.currentTime);
    parameter.setTargetAtTime(value, context.currentTime, timeConstant);
    // A true zero after the inaudible tail keeps mute/zero-volume exact.
    if (settleSilence && value === 0) parameter.setValueAtTime(0, context.currentTime + timeConstant * 8);
  }

  function applyWeather(frame: EnvironmentSnapshot, force = false): void {
    // A settings dialog freezes world updates. Never swallow the final rain
    // slider input, even when several inputs arrive inside one audio tick.
    if (!force && context.currentTime < nextWeatherUpdate && frame.precipitation === lastPrecipitation) return;
    nextWeatherUpdate = context.currentTime + 0.05;
    lastPrecipitation = frame.precipitation;
    const v = voiceWeather(frame);
    smooth(low.amplitude, v.lowGain, 0.28);
    smooth(air.amplitude, v.airGain, 0.24);
    smooth(low.pan, v.lowPan, 0.5);
    smooth(air.pan, v.airPan, 0.5);
    smooth(low.source.playbackRate, v.lowRate, 0.6);
    smooth(air.source.playbackRate, v.airRate, 0.6);
    smooth(rainLeft.amplitude, v.rainLeftGain, 0.24);
    smooth(rainRight.amplitude, v.rainRightGain, 0.24);
    smooth(rainLeft.pan, v.rainLeftPan, 0.5);
    smooth(rainRight.pan, v.rainRightPan, 0.5);
    smooth(drops.amplitude, v.dropGain, 0.18);
    smooth(roof.amplitude, v.roofGain, 0.18);
    smooth(drops.pan, v.dropPan, 0.5);
    smooth(roof.pan, v.roofPan, 0.5);
    smooth(fire.amplitude, v.fireGain, 0.12);
    smooth(embers.amplitude, v.emberGain, 0.16);
    smooth(fire.pan, v.firePan, 0.5);
  }

  return {
    sourceCount: sources.length,
    update(frame) {
      if (disposed) return;
      latestFrame = frame;
      applyWeather(frame);
    },
    setVolume(value) {
      if (disposed) return;
      const safeVolume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      if (!active) {
        // A preference set before enabling or while paused must be in place
        // before the gate opens; fading from the old volume would leak sound.
        volume.gain.cancelScheduledValues(context.currentTime);
        volume.gain.setValueAtTime(safeVolume, context.currentTime);
      } else smooth(volume.gain, safeVolume, 0.06, true);
    },
    setActive(value) {
      if (disposed || active === value) return;
      active = value;
      // currentTime stops with a suspended context. Re-apply the newest world
      // sample on resume so the throttle cannot preserve stale weather.
      if (value && latestFrame) applyWeather(latestFrame, true);
      smooth(gate.gain, value ? 1 : 0, value ? 0.14 : 0.025, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gate.gain.cancelScheduledValues(context.currentTime);
      gate.gain.value = 0;
      for (const source of sources) { source.stop(); source.buffer = null; }
      for (const node of nodes) node.disconnect();
      sources.length = 0;
      nodes.length = 0;
    },
  };
}
