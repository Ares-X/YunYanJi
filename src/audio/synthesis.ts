import { createRandom } from '../core/random';

/** PCM is synthesized once and kept in memory; there are no recorded samples. */
export function generateWindLoop(seed: string, frames: number): Float32Array {
  if (!Number.isSafeInteger(frames) || frames < 128) {
    throw new RangeError('A wind loop needs at least 128 samples.');
  }

  const samples = new Float32Array(frames);
  const slowPole = 0.982;
  const fastPole = 0.88;
  let slow = 0;
  let fast = 0;

  // Solve each one-pole filter's periodic starting state. A zero-state pass
  // gives end = a^N * start + drivenEnd, so start = drivenEnd / (1 - a^N).
  // Replaying the seeded excitation from that state preserves stationary noise
  // through the wrap; no quiet interpolation/fade segment replaces the tail.
  const warmup = createRandom(`${seed}:wind`);
  for (let index = 0; index < frames; index += 1) {
    const white = warmup() * 2 - 1;
    slow = slowPole * slow + (1 - slowPole) * white;
    fast = fastPole * fast + (1 - fastPole) * white;
  }
  slow /= 1 - slowPole ** frames;
  fast /= 1 - fastPole ** frames;
  const random = createRandom(`${seed}:wind`);
  for (let index = 0; index < frames; index += 1) {
    const white = random() * 2 - 1;
    slow = slowPole * slow + (1 - slowPole) * white;
    fast = fastPole * fast + (1 - fastPole) * white;
    samples[index] = slow * 0.72 + fast * 0.28;
  }

  // Remove DC before peak normalization. Both endpoints receive the same transform.
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= frames;
  let peak = 0;
  for (let index = 0; index < frames; index += 1) {
    const value = (samples[index] ?? 0) - mean;
    samples[index] = value;
    peak = Math.max(peak, Math.abs(value));
  }
  const scale = peak > 0 ? 0.78 / peak : 0;
  for (let index = 0; index < frames; index += 1) {
    samples[index] = (samples[index] ?? 0) * scale;
  }
  return samples;
}

/** Quiet friction-driven resonances: a wooden eave settling in the wind. */
export function generateTimberLoop(
  seed: string,
  sampleRate: number,
  duration = 31.31,
): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || !Number.isFinite(duration) || duration < 1) {
    throw new RangeError('Timber synthesis requires a valid sample rate and duration.');
  }
  const random = createRandom(`${seed}:timber`);
  const frames = Math.floor(sampleRate * duration);
  const samples = new Float32Array(frames);
  let eventTime = Math.min(duration * 0.2, 0.35 + random() * 0.65);
  while (eventTime < duration - 0.15) {
    const start = Math.floor(eventTime * sampleRate);
    const length = Math.min(Math.floor((0.3 + random() * 0.35) * sampleRate), frames - start - 1);
    const fundamental = 92 + random() * 74;
    const frequencies = [fundamental, fundamental * (2.13 + random() * 0.2), fundamental * (3.47 + random() * 0.3)];
    const modes = frequencies.map((frequency, index) => {
      const radius = Math.exp(-1 / (sampleRate * (0.013 + random() * 0.014)));
      return { feedback: 2 * radius * Math.cos(2 * Math.PI * frequency / sampleRate), damping: radius * radius, input: 1 - radius, weight: [0.54, 0.28, 0.12][index] ?? 0, previous: 0, older: 0 };
    });
    const event = new Float32Array(length);
    const envelope = new Float32Array(length);
    let friction = 0;
    let sum = 0;
    let envelopeSum = 0;
    for (let index = 0; index < length; index += 1) {
      const progress = index / Math.max(1, length - 1);
      const window = Math.sin(Math.PI * progress) ** 2 * Math.exp(-2.8 * progress);
      friction += ((random() * 2 - 1) - friction) * 0.16;
      let resonance = 0;
      for (const mode of modes) {
        const value = mode.input * friction + mode.feedback * mode.previous - mode.damping * mode.older;
        mode.older = mode.previous;
        mode.previous = value;
        resonance += value * mode.weight;
      }
      event[index] = resonance * window;
      envelope[index] = window;
      sum += event[index] ?? 0;
      envelopeSum += window;
    }
    // Remove event DC inside its own window, keeping the intervening silence.
    const offset = envelopeSum > 0 ? sum / envelopeSum : 0;
    for (let index = 0; index < length; index += 1) {
      samples[start + index] = (event[index] ?? 0) - offset * (envelope[index] ?? 0);
    }
    // Uneven intervals replace the old evenly spaced three-event pattern.
    eventTime += 2.4 + random() * 4.8;
  }
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak > 0) {
    const scale = 0.42 / peak;
    for (let index = 0; index < samples.length; index += 1) samples[index] = (samples[index] ?? 0) * scale;
  }
  return samples;
}
