import { describe, expect, it } from 'vitest';
import {
  generateEmberLoop, generateFireCrackleLoop, generateRainDropsLoop, generateRainLoop, generateWindLoop,
} from '../../src/audio/synthesis';

function stats(samples: Float32Array) {
  let sum = 0;
  let energy = 0;
  let differenceEnergy = 0;
  let peak = 0;
  let finite = true;
  let silent = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    finite &&= Number.isFinite(sample);
    if (sample === 0) silent++;
    sum += sample;
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (index > 0) differenceEnergy += (sample - (samples[index - 1] ?? 0)) ** 2;
  }
  expect(finite).toBe(true);
  return {
    mean: sum / samples.length,
    rms: Math.sqrt(energy / samples.length),
    peak,
    differenceEnergyRatio: differenceEnergy / energy,
    silentFraction: silent / samples.length,
  };
}

describe('generated ambience samples', () => {
  it('recreates the same scene without sharing random state between sound layers', () => {
    for (const generator of [generateWindLoop, generateRainLoop, generateEmberLoop]) {
      const original = generator('refuge:near', 16000);
      generator('refuge:other', 8000);
      expect(generator('refuge:near', 16000)).toEqual(original);
      expect(generator('refuge:far', 16000)).not.toEqual(original);
    }
  });

  it('creates bounded, DC-free, soft noise with a continuous loop seam', () => {
    const samples = generateWindLoop('rainfire', 32000);
    const result = stats(samples);
    expect(result.peak).toBeLessThanOrEqual(0.781);
    expect(result.rms).toBeGreaterThan(0.06);
    expect(result.rms).toBeLessThan(0.35);
    expect(Math.abs(result.mean)).toBeLessThan(1e-6);
    // A sampled noise loop need not duplicate its first and last samples. Its
    // boundary step should be an ordinary noise step, not an exceptional impulse.
    const stepRms = result.rms * Math.sqrt(result.differenceEnergyRatio);
    expect(Math.abs((samples[0] ?? 0) - (samples.at(-1) ?? 0))).toBeLessThan(stepRms * 4);
    // White noise's first-difference energy is around 2x its energy. Wind needs
    // much less high-frequency energy than the surrounding rain.
    expect(result.differenceEnergyRatio).toBeLessThan(0.3);
  });

  it('preserves noise energy at the loop boundary instead of inserting a quiet fade', () => {
    for (const seed of ['rainfire', 'qa-refuge:ambience:air-high', 'quiet-eaves']) {
      const samples = generateWindLoop(seed, 16000 * 9);
      const body = stats(samples.subarray(1024, -1024));
      const tail = stats(samples.subarray(-1024));
      const bodyDifferenceEnergy = body.rms ** 2 * body.differenceEnergyRatio;
      const tailDifferenceEnergy = tail.rms ** 2 * tail.differenceEnergyRatio;
      // The removed Hermite tail had ~0.00006 of the normal difference energy:
      // a high-pass filter consequently turned that part of each loop silent.
      expect(tailDifferenceEnergy / bodyDifferenceEnergy).toBeGreaterThan(0.4);
      expect(tailDifferenceEnergy / bodyDifferenceEnergy).toBeLessThan(1.8);
    }
  });

  it('keeps the rain broad but softer than white static, without a loop seam impulse', () => {
    const samples = generateRainLoop('rainfire', 24000 * 7);
    const result = stats(samples);
    const wind = stats(generateWindLoop('rainfire', samples.length));
    expect(result.peak).toBeLessThan(0.67);
    expect(result.rms).toBeGreaterThan(0.08);
    expect(result.rms).toBeLessThan(0.3);
    expect(Math.abs(result.mean)).toBeLessThan(1e-6);
    expect(result.differenceEnergyRatio).toBeGreaterThan(wind.differenceEnergyRatio * 3);
    expect(result.differenceEnergyRatio).toBeLessThan(1.3);
    expect(Math.abs((samples[0] ?? 0) - (samples.at(-1) ?? 0)))
      .toBeLessThan(result.rms * Math.sqrt(result.differenceEnergyRatio) * 4);
  });

  it('separates frequent rain impacts from sparse fire fractures with genuine gaps', () => {
    const fire = generateFireCrackleLoop('rainfire', 24000, 12);
    const fireStats = stats(fire);
    const stone = stats(generateRainDropsLoop('rainfire', 24000, 12, 'stone'));
    const shelter = stats(generateRainDropsLoop('rainfire', 24000, 12, 'shelter'));
    for (const result of [fireStats, stone, shelter]) {
      expect(result.peak).toBeLessThan(0.67);
      expect(result.rms).toBeGreaterThan(0.005);
      expect(result.rms).toBeLessThan(0.09);
      expect(Math.abs(result.mean)).toBeLessThan(1e-6);
    }
    // Fire must remain intermittent; rain impacts should merge into a textured
    // field. Crest factor also distinguishes the close snaps from a noise bed.
    expect(fireStats.silentFraction).toBeGreaterThan(0.65);
    expect(fireStats.peak / fireStats.rms).toBeGreaterThan(20);
    expect(stone.silentFraction).toBeLessThan(0.35);
    expect(shelter.silentFraction).toBeLessThan(0.35);
    expect(shelter.differenceEnergyRatio).toBeLessThan(stone.differenceEnergyRatio * 0.65);
    expect(generateFireCrackleLoop('rainfire', 24000, 12)).toEqual(fire);
    expect(generateRainDropsLoop('same-seed', 16000, 2))
      .toEqual(generateRainDropsLoop('same-seed', 16000, 2));
  });

  it('rejects unusable synthesis dimensions instead of allocating invalid buffers', () => {
    for (const generator of [generateWindLoop, generateRainLoop, generateEmberLoop]) {
      expect(() => generator('rainfire', 0)).toThrow(RangeError);
      expect(() => generator('rainfire', Number.NaN)).toThrow(RangeError);
    }
    for (const generator of [generateFireCrackleLoop, generateRainDropsLoop]) {
      expect(() => generator('rainfire', 0)).toThrow(RangeError);
      expect(() => generator('rainfire', 16000, Number.NaN)).toThrow(RangeError);
    }
  });
});
