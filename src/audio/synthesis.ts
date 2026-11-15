import { createRandom } from '../core/random';

function requireFrames(frames: number): void {
  if (!Number.isSafeInteger(frames) || frames < 128 || frames > 24_000_000) {
    throw new RangeError('A synthesized loop requires 128–24,000,000 samples.');
  }
}

function frameCount(sampleRate: number, duration: number): number {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 96000
    || !Number.isFinite(duration) || duration < 1 || duration > 120) {
    throw new RangeError('Synthesis requires a valid sample rate and a 1–120 second duration.');
  }
  return Math.floor(sampleRate * duration);
}

function normalize(samples: Float32Array, ceiling: number, removeDc = true): Float32Array {
  let mean = 0;
  if (removeDc) {
    for (const sample of samples) mean += sample;
    mean /= samples.length;
  }
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = (samples[i] ?? 0) - mean;
    samples[i] = value;
    peak = Math.max(peak, Math.abs(value));
  }
  const scale = peak > 0 ? ceiling / peak : 0;
  for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] ?? 0) * scale;
  return samples;
}

/** Stationary coloured noise: solve each filter's periodic starting state. */
function noiseLoop(seed: string, frames: number, poles: readonly number[],
  weights: readonly number[], whiteWeight: number, ceiling: number): Float32Array {
  requireFrames(frames);
  const state = poles.map(() => 0);
  const warmup = createRandom(`${seed}:noise`);
  for (let i = 0; i < frames; i++) {
    const white = warmup() * 2 - 1;
    for (let p = 0; p < poles.length; p++) {
      const pole = poles[p]!;
      state[p] = pole * state[p]! + (1 - pole) * white;
    }
  }
  for (let p = 0; p < poles.length; p++) state[p] = state[p]! / (1 - poles[p]! ** frames);
  const samples = new Float32Array(frames);
  const random = createRandom(`${seed}:noise`);
  for (let i = 0; i < frames; i++) {
    const white = random() * 2 - 1;
    let value = white * whiteWeight;
    for (let p = 0; p < poles.length; p++) {
      const pole = poles[p]!;
      state[p] = pole * state[p]! + (1 - pole) * white;
      value += state[p]! * weights[p]!;
    }
    samples[i] = value;
  }
  return normalize(samples, ceiling);
}

/** Soft low-frequency air, generated once without a quiet seam/fade segment. */
export function generateWindLoop(seed: string, frames: number): Float32Array {
  return noiseLoop(`${seed}:wind`, frames, [0.982, 0.88], [0.72, 0.28], 0, 0.78);
}

/** Broad rain on distant foliage, with less high-frequency energy than static. */
export function generateRainLoop(seed: string, frames: number): Float32Array {
  const samples = noiseLoop(`${seed}:rain`, frames, [0.55, 0.86, 0.985], [0.66, 0.35, -0.22], 0.075, 0.66);
  const random = createRandom(`${seed}:rain-swells`);
  const first = random() * Math.PI * 2, second = random() * Math.PI * 2;
  // Integral cycle counts keep the amplitude field continuous at the wrap.
  for (let i = 0; i < samples.length; i++) {
    const phase = i / samples.length * Math.PI * 2;
    samples[i] = samples[i]! * (0.91 + Math.sin(phase * 3 + first) * 0.055
      + Math.sin(phase * 7 + second) * 0.035);
  }
  return normalize(samples, 0.66);
}

/** Low, warm turbulence under the individual dry snaps of burning wood. */
export function generateEmberLoop(seed: string, frames: number): Float32Array {
  return noiseLoop(`${seed}:embers`, frames, [0.82, 0.98], [1, -0.75], 0.025, 0.58);
}

function addTransient(samples: Float32Array, start: number, event: Float32Array,
  envelope: Float32Array, amplitude: number): void {
  let total = 0, weight = 0;
  for (let i = 0; i < event.length; i++) {
    total += event[i]!;
    weight += envelope[i]!;
  }
  // Remove each event's DC within its own envelope, preserving the silence
  // between events and avoiding an artificial low-frequency step at its ends.
  const offset = weight > 0 ? total / weight : 0;
  for (let i = 0; i < event.length; i++) {
    const index = (start + i) % samples.length;
    samples[index] = samples[index]! + (event[i]! - offset * envelope[i]!) * amplitude;
  }
}

/** Small, irregular impacts. The body is noise-dominant, never a pitched melody. */
export function generateRainDropsLoop(seed: string, sampleRate: number, duration = 29.53,
  surface: 'stone' | 'shelter' = 'stone'): Float32Array {
  const frames = frameCount(sampleRate, duration);
  const samples = new Float32Array(frames);
  const random = createRandom(`${seed}:drops:${surface}`);
  const rate = surface === 'stone' ? 27 : 17;
  let time = -Math.log(Math.max(1e-8, random())) / rate;
  while (time < duration) {
    const decay = surface === 'stone' ? 0.008 + random() * 0.013 : 0.012 + random() * 0.020;
    const attack = 0.0008 + random() * 0.0016;
    const length = Math.ceil((decay * 6 + attack) * sampleRate);
    const event = new Float32Array(length), envelope = new Float32Array(length);
    const frequency = surface === 'stone' ? 850 + random() * 2600 : 210 + random() * 690;
    const secondMode = frequency * (1.67 + random() * 1.6);
    const amplitude = 0.10 + random() ** 3 * 0.86;
    let colour = 0;
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate;
      const end = 1 - i / (length - 1);
      const window = (1 - Math.exp(-t / attack)) * Math.exp(-t / decay) * end * end;
      const white = random() * 2 - 1;
      colour += (white - colour) * (surface === 'stone' ? 0.52 : 0.22);
      const body = Math.sin(2 * Math.PI * frequency * t * (1 - t * 1.8)) * 0.10
        + Math.sin(2 * Math.PI * secondMode * t) * 0.055;
      envelope[i] = window;
      event[i] = (colour * 1.15 + body) * window;
    }
    addTransient(samples, Math.floor(time * sampleRate), event, envelope, amplitude);
    time += -Math.log(Math.max(1e-8, random())) / rate;
  }
  return normalize(samples, 0.64, false);
}

/** Clustered dry fractures and a few lower woody pops; no evenly spaced ticks. */
export function generateFireCrackleLoop(seed: string, sampleRate: number, duration = 43.43): Float32Array {
  const samples = new Float32Array(frameCount(sampleRate, duration));
  const random = createRandom(`${seed}:fire-crackle`);
  let time = 0.13 + random() * 0.21;
  while (time < duration - 0.22) {
    const cluster = random() < 0.58 ? 2 + Math.floor(random() * 4) : 1;
    const woody = random() < 0.11;
    for (let part = 0; part < cluster; part++) {
      const onset = time + part * (0.005 + random() * 0.024);
      const decay = woody ? 0.013 + random() * 0.014 : 0.0025 + random() * 0.0045;
      const attack = woody ? 0.0012 : 0.00035;
      const length = Math.ceil((decay * 7 + attack) * sampleRate);
      const event = new Float32Array(length), envelope = new Float32Array(length);
      const amplitude = (0.08 + random() ** 2 * 0.92) / (1 + part * 0.26);
      const frequency = 140 + random() * 350;
      let colour = 0;
      for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        const end = 1 - i / (length - 1);
        const window = (1 - Math.exp(-t / attack)) * Math.exp(-t / decay) * end;
        const white = random() * 2 - 1;
        colour += (white - colour) * (woody ? 0.19 : 0.56);
        const noise = woody ? colour * 1.5 : white * 0.38 + colour * 0.62;
        const body = woody ? Math.sin(2 * Math.PI * frequency * t) * 0.22
          + Math.sin(2 * Math.PI * frequency * 2.81 * t) * 0.06 : 0;
        envelope[i] = window;
        event[i] = (noise + body) * window;
      }
      addTransient(samples, Math.floor(onset * sampleRate), event, envelope, amplitude);
    }
    time += 0.065 + -Math.log(Math.max(1e-8, random())) / 3.1;
  }
  return normalize(samples, 0.66, false);
}
