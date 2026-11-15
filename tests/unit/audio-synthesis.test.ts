import { describe, expect, it } from 'vitest';
import {
  generateEmberLoop, generateFireCrackleLoop, generateRainDropsLoop, generateRainLoop,
  generateSnowLoop, generateThunder, generateWindLoop, generateWoodFeed,
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
    for (const generator of [generateWindLoop, generateRainLoop, generateEmberLoop, generateSnowLoop]) {
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
    for (const generator of [generateWindLoop, generateRainLoop, generateEmberLoop, generateSnowLoop]) {
      expect(() => generator('rainfire', 0)).toThrow(RangeError);
      expect(() => generator('rainfire', Number.NaN)).toThrow(RangeError);
    }
    for (const generator of [generateFireCrackleLoop, generateRainDropsLoop, generateThunder]) {
      expect(() => generator('rainfire', 0)).toThrow(RangeError);
      expect(() => generator('rainfire', 16000, Number.NaN)).toThrow(RangeError);
    }
    expect(() => generateWoodFeed('rainfire', 0)).toThrow(RangeError);
  });

  it('gives thunder a finite unpitched low roll and a smooth, silent ending', () => {
    const thunder = generateThunder('distant-valley', 16000, 9);
    const result = stats(thunder);
    const head = stats(thunder.subarray(0, 16000));
    const middle = stats(thunder.subarray(16000, 16000 * 6));
    const tail = stats(thunder.subarray(-16000));
    expect(result.peak).toBeLessThanOrEqual(0.821);
    expect(result.rms).toBeGreaterThan(0.02);
    expect(Math.abs(result.mean)).toBeLessThan(1e-6);
    // The initial pressure crack is brighter than the prolonged low roll.
    expect(result.differenceEnergyRatio).toBeLessThan(0.25);
    expect(middle.differenceEnergyRatio).toBeLessThan(head.differenceEnergyRatio);
    expect(middle.rms).toBeGreaterThan(head.rms * 0.1);
    expect(tail.rms).toBeLessThan(head.rms * 0.1);
    expect(thunder[0]).toBe(0);
    expect(Math.abs(thunder.at(-1)!)).toBeLessThan(1e-7);
    expect(generateThunder('distant-valley', 16000, 9)).toEqual(thunder);
    expect(generateThunder('another-valley', 16000, 9)).not.toEqual(thunder);
  });

  it('keeps snow softer in frequency than rain and gives cold/hot feeding different transients', () => {
    const snow = stats(generateSnowLoop('roof', 48000));
    const rain = stats(generateRainLoop('roof', 48000));
    expect(snow.differenceEnergyRatio).toBeLessThan(rain.differenceEnergyRatio * 0.4);
    expect(snow.peak).toBeLessThan(0.47);
    const hot = generateWoodFeed('hearth', 16000, true);
    const cold = generateWoodFeed('hearth', 16000, false);
    for (const samples of [hot, cold]) {
      const result = stats(samples);
      expect(result.peak).toBeLessThan(0.69);
      expect(result.rms).toBeGreaterThan(0.01);
      expect(Math.abs(result.mean)).toBeLessThan(1e-6);
      expect(samples[0]).toBe(0);
      expect(Math.abs(samples.at(-1)!)).toBeLessThan(1e-7);
    }
    expect(hot).not.toEqual(cold);
    expect(generateWoodFeed('hearth', 16000, true)).toEqual(hot);
  });
});
