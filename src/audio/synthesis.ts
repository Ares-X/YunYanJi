import { createRandom } from '../core/random';

/** PCM is synthesized once and kept in memory; there are no recorded samples. */
export function generateWindLoop(seed: string, frames: number): Float32Array {
  if (!Number.isSafeInteger(frames) || frames < 128) {
    throw new RangeError('A wind loop needs at least 128 samples.');
  }

  const random = createRandom(`${seed}:wind`);
  const samples = new Float32Array(frames);
  let slow = 0;
  let fast = 0;
  // Two correlated, low-pass noise bands produce a soft continuous air bed.
  for (let index = 0; index < frames; index += 1) {
    const white = random() * 2 - 1;
    slow += (white - slow) * 0.018;
    fast += (white - fast) * 0.12;
    samples[index] = slow * 0.72 + fast * 0.28;
  }

  // A short smooth bridge joins the tail to the head, including its slope.
  // This avoids the pop made by simply looping an unrelated last sample.
  const bridge = Math.min(1024, Math.floor(frames / 8));
  const start = frames - bridge;
  const from = samples[start] ?? 0;
  const fromSlope = from - (samples[start - 1] ?? from);
  const to = samples[0] ?? 0;
  const toSlope = (samples[1] ?? to) - to;
  for (let index = 0; index < bridge; index += 1) {
    const t = index / (bridge - 1);
    const t2 = t * t;
    const t3 = t2 * t;
    // Limit tangents so a long bridge cannot introduce a large low-frequency swell.
    const tangentScale = Math.min(12, bridge - 1);
    samples[start + index] =
      (2 * t3 - 3 * t2 + 1) * from +
      (t3 - 2 * t2 + t) * fromSlope * tangentScale +
      (-2 * t3 + 3 * t2) * to +
      (t3 - t2) * toSlope * tangentScale;
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

/** Quiet, sparse, damped resonances: a wooden eave settling in the wind. */
export function generateTimberLoop(
  seed: string,
  sampleRate: number,
  duration = 13,
): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || !Number.isFinite(duration) || duration < 1) {
    throw new RangeError('Timber synthesis requires a valid sample rate and duration.');
  }
  const random = createRandom(`${seed}:timber`);
  const frames = Math.floor(sampleRate * duration);
  const samples = new Float32Array(frames);
  const events = Math.max(1, Math.floor(duration / 3.6));
  for (let event = 0; event < events; event += 1) {
    const eventTime = 0.3 + ((event + random() * 0.55) / events) * (duration - 1.15);
    const start = Math.floor(eventTime * sampleRate);
    const length = Math.floor((0.34 + random() * 0.28) * sampleRate);
    const fundamental = 84 + random() * 62;
    const phase = random() * Math.PI * 2;
    for (let index = 0; index < length && start + index < frames - 1; index += 1) {
      const time = index / sampleRate;
      const progress = index / length;
      const attack = Math.min(1, time / 0.045);
      const envelope = attack * Math.exp(-7 * progress) * Math.pow(1 - progress, 2);
      const bend = fundamental * time + 3.2 * time * time;
      const resonance =
        Math.sin(2 * Math.PI * bend + phase) * 0.48 +
        Math.sin(2 * Math.PI * bend * 1.93 + phase) * 0.2 +
        Math.sin(2 * Math.PI * bend * 3.17) * 0.08;
      const friction = (random() * 2 - 1) * 0.025;
      samples[start + index] = (samples[start + index] ?? 0) + (resonance + friction) * envelope;
    }
  }
  return samples;
}
