import type { EnvironmentSnapshot } from '../core/types';
import {
  generateEmberLoop, generateFireCrackleLoop, generateRainDropsLoop, generateRainLoop,
  generateSnowLoop, generateThunder, generateWindLoop, generateWoodFeed,
} from './synthesis';
import { createRainfireVoicing } from './rainfireVoicing';
import { AmbienceEventCursor } from './audioEvents';
import type { AmbienceEvent } from './audioEvents';

export interface AmbienceGraph {
  update(frame: EnvironmentSnapshot): void;
  setVolume(volume: number): void;
  setActive(active: boolean): void;
  dispose(): void;
  diagnostics(): Record<string, number>;
  readonly sourceCount: number;
}

export const SYNTHESIS_SAMPLE_RATE = 24000;
export const AMBIENCE_LOOP_SOURCES = 9;
export const MAX_TRANSIENT_SOURCES = 4;

interface TransientVoice {
  readonly kind: AmbienceEvent['kind'];
  readonly source: AudioBufferSourceNode;
  readonly nodes: readonly AudioNode[];
  release(stop: boolean): void;
}

/** Nine cached beds, three cached thunder variants and two wood impacts; no fetched sound. */
export function createAmbienceGraph(context: BaseAudioContext, seed: string): AmbienceGraph {
  const nodes: AudioNode[] = [];
  const sources: AudioBufferSourceNode[] = [];
  const transients = new Set<TransientVoice>();
  const eventCursor = new AmbienceEventCursor();
  const targets = new WeakMap<AudioParam, number>();
  let disposed = false;
  let nextWeatherUpdate = -1;
  let latestFrame: EnvironmentSnapshot | null = null;
  let lastState = '';
  let active = false;
  let currentVolume = 0.45;
  let thunderStarted = 0, woodStarted = 0, peakTransients = 0;
  const voiceWeather = createRainfireVoicing(seed);

  function own<T extends AudioNode>(node: T): T { nodes.push(node); return node; }
  function gain(value: number): GainNode {
    const node = own(context.createGain());
    node.gain.value = value;
    return node;
  }
  function buffer(samples: Float32Array): AudioBuffer {
    const result = context.createBuffer(1, samples.length, SYNTHESIS_SAMPLE_RATE);
    result.getChannelData(0).set(samples);
    return result;
  }

  const volume = gain(currentVolume), gate = gain(0);
  const limiter = own(context.createDynamicsCompressor());
  limiter.threshold.value = -13;
  limiter.knee.value = 6;
  limiter.ratio.value = 3;
  limiter.attack.value = 0.006;
  limiter.release.value = 0.25;
  volume.connect(limiter).connect(gate).connect(context.destination);

  function layer(samples: Float32Array, position: number) {
    const source = own(context.createBufferSource());
    source.buffer = buffer(samples);
    source.loop = true;
    sources.push(source);
    const amplitude = gain(0);
    const pan = own(context.createStereoPanner());
    pan.pan.value = position;
    source.connect(amplitude).connect(pan).connect(volume);
    return { source, amplitude: amplitude.gain, pan: pan.pan };
  }

  // Incommensurate lengths and independent seeds avoid repeated stereo swells.
  const low = layer(generateWindLoop(`${seed}:air-low`, 240007), -0.24);
  const air = layer(generateWindLoop(`${seed}:air-high`, 312019), 0.30);
  const rainLeft = layer(generateRainLoop(`${seed}:distant-rain-left`, 384017), -0.68);
  const rainRight = layer(generateRainLoop(`${seed}:distant-rain-right`, 456043), 0.66);
  const drops = layer(generateRainDropsLoop(`${seed}:wet-stone`, SYNTHESIS_SAMPLE_RATE, 29.53, 'stone'), 0.26);
  const roof = layer(generateRainDropsLoop(`${seed}:shelter-edge`, SYNTHESIS_SAMPLE_RATE, 37.19, 'shelter'), -0.38);
  const fire = layer(generateFireCrackleLoop(`${seed}:close-fire`, SYNTHESIS_SAMPLE_RATE), -0.13);
  const embers = layer(generateEmberLoop(`${seed}:fire-breath`, 408023), -0.13);
  const snow = layer(generateSnowLoop(`${seed}:snow-on-cloth`, 528043), -0.20);
  const thunderBuffers = [9.3, 10.7, 11.9].map((duration, index) =>
    buffer(generateThunder(`${seed}:thunder-${index}`, SYNTHESIS_SAMPLE_RATE, duration)));
  const woodBuffers = [false, true].map(hot => buffer(generateWoodFeed(`${seed}:placed-wood`, SYNTHESIS_SAMPLE_RATE, hot)));
  for (const source of sources) source.start(context.currentTime);

  function smooth(parameter: AudioParam, value: number, timeConstant: number, settleSilence = false): void {
    // Preserve an already scheduled exact zero. Reissuing it every frame would
    // keep moving that zero into the future and leave an asymptotic noise tail.
    if (targets.get(parameter) === value) return;
    targets.set(parameter, value);
    parameter.cancelScheduledValues(context.currentTime);
    // Preparing an inaudible graph must install the selected weather exactly.
    // Otherwise enabling on a dry day could briefly reveal its old rain bed.
    if (!active) { parameter.setValueAtTime(value, context.currentTime); return; }
    parameter.setTargetAtTime(value, context.currentTime, timeConstant);
    if (settleSilence && value === 0) parameter.setValueAtTime(0, context.currentTime + timeConstant * 8);
  }

  function stopTransients(): void {
    for (const voice of [...transients]) voice.release(true);
  }

  function playEvent(event: AmbienceEvent): void {
    // Two rolls can overlap, as can two settling logs. Repeated input never
    // grows the graph unboundedly, including while onended awaits dispatch.
    const sameKind = [...transients].filter(voice => voice.kind === event.kind);
    if (sameKind.length >= 2) sameKind[0]!.release(true);
    const source = context.createBufferSource();
    const amplitude = context.createGain();
    const pan = context.createStereoPanner();
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    source.buffer = event.kind === 'thunder' ? thunderBuffers[event.id % thunderBuffers.length]!
      : woodBuffers[event.hot ? 1 : 0]!;
    if (event.kind === 'thunder') {
      const distance = Math.max(80, event.distance);
      amplitude.gain.value = Math.min(0.62, (0.40 + event.intensity * 0.20) / (1 + distance / 3000));
      filter.frequency.value = Math.max(420, 3700 / (1 + distance / 600));
      pan.pan.setValueAtTime(Math.max(-0.75, Math.min(0.75, event.pan)), context.currentTime);
      pan.pan.linearRampToValueAtTime(event.pan * 0.35, context.currentTime + source.buffer.duration * 0.8);
      thunderStarted++;
    } else {
      amplitude.gain.value = event.hot ? 0.20 : 0.16;
      filter.frequency.value = 6000;
      pan.pan.value = -0.13;
      woodStarted++;
    }
    source.connect(filter).connect(amplitude).connect(pan).connect(volume);
    let released = false;
    const voice: TransientVoice = {
      kind: event.kind, source, nodes: [source, filter, amplitude, pan],
      release(stop) {
        if (released) return;
        released = true;
        source.onended = null;
        if (stop) source.stop();
        source.buffer = null;
        for (const node of voice.nodes) node.disconnect();
        transients.delete(voice);
      },
    };
    source.onended = () => voice.release(false);
    transients.add(voice);
    peakTransients = Math.max(peakTransients, transients.size);
    source.start(context.currentTime, event.offset);
  }

  function applyWeather(frame: EnvironmentSnapshot, force = false): void {
    // Inputs may change at frozen simulation time. Do not throttle away the
    // final rain/snow/fire choice, or keep an extinguished fire audible.
    const signature = `${frame.weather.revision}:${frame.fire.revision}:${frame.weather.rain}:${frame.weather.snow}`;
    if (!force && context.currentTime < nextWeatherUpdate && signature === lastState) return;
    nextWeatherUpdate = context.currentTime + 0.05;
    lastState = signature;
    const v = voiceWeather(frame);
    smooth(low.amplitude, v.lowGain, 0.28);
    smooth(air.amplitude, v.airGain, 0.24);
    smooth(low.pan, v.lowPan, 0.5);
    smooth(air.pan, v.airPan, 0.5);
    smooth(low.source.playbackRate, v.lowRate, 0.6);
    smooth(air.source.playbackRate, v.airRate, 0.6);
    smooth(rainLeft.amplitude, v.rainLeftGain, 0.24, true);
    smooth(rainRight.amplitude, v.rainRightGain, 0.24, true);
    smooth(rainLeft.pan, v.rainLeftPan, 0.5);
    smooth(rainRight.pan, v.rainRightPan, 0.5);
    smooth(drops.amplitude, v.dropGain, 0.18, true);
    smooth(roof.amplitude, v.roofGain, 0.18, true);
    smooth(drops.source.playbackRate, v.dropRate, 0.4);
    smooth(roof.source.playbackRate, v.roofRate, 0.4);
    smooth(drops.pan, v.dropPan, 0.5);
    smooth(roof.pan, v.roofPan, 0.5);
    smooth(snow.amplitude, v.snowGain, 0.3, true);
    smooth(snow.pan, v.snowPan, 0.5);
    smooth(fire.amplitude, v.fireGain, 0.10, true);
    smooth(embers.amplitude, v.emberGain, 0.16, true);
    smooth(fire.pan, v.firePan, 0.5);
  }

  return {
    get sourceCount() { return sources.length + transients.size; },
    diagnostics() {
      return { audioLoopSources: sources.length, audioTransientSources: transients.size,
        audioNodes: nodes.length + [...transients].reduce((total, voice) => total + voice.nodes.length, 0),
        audioThunders: thunderStarted, audioWoodEvents: woodStarted, audioPeakTransients: peakTransients };
    },
    update(frame) {
      if (disposed) return;
      latestFrame = frame;
      applyWeather(frame);
      const result = eventCursor.update(frame, active && currentVolume > 0);
      if (result.reset) stopTransients();
      for (const event of result.events) playEvent(event);
    },
    setVolume(value) {
      if (disposed) return;
      currentVolume = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      if (currentVolume === 0) stopTransients();
      if (!active) {
        targets.delete(volume.gain);
        volume.gain.cancelScheduledValues(context.currentTime);
        volume.gain.setValueAtTime(currentVolume, context.currentTime);
      } else smooth(volume.gain, currentVolume, 0.06, true);
    },
    setActive(value) {
      if (disposed || active === value) return;
      active = value;
      if (latestFrame) eventCursor.prime(latestFrame);
      if (!value) stopTransients();
      if (value && latestFrame) applyWeather(latestFrame, true);
      smooth(gate.gain, value ? 1 : 0, value ? 0.14 : 0.025, true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      gate.gain.cancelScheduledValues(context.currentTime);
      gate.gain.value = 0;
      stopTransients();
      for (const source of sources) { source.stop(); source.buffer = null; }
      for (const node of nodes) node.disconnect();
      sources.length = 0;
      nodes.length = 0;
      thunderBuffers.length = 0;
      woodBuffers.length = 0;
      latestFrame = null;
    },
  };
}
