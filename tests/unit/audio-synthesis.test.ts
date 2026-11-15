import { describe, expect, it } from 'vitest';
import { generateTimberLoop, generateWindLoop } from '../../src/audio/synthesis';

function stats(samples: Float32Array) {
  let sum = 0;
  let energy = 0;
  let differenceEnergy = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    expect(Number.isFinite(sample)).toBe(true);
    sum += sample;
    energy += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (index > 0) differenceEnergy += (sample - (samples[index - 1] ?? 0)) ** 2;
  }
  return {
    mean: sum / samples.length,
    rms: Math.sqrt(energy / samples.length),
    peak,
    differenceEnergyRatio: differenceEnergy / energy,
  };
}

describe('generated ambience samples', () => {
  it('recreates the same scene without sharing random state between sound layers', () => {
    const original = generateWindLoop('courtyard:low', 16000);
    generateWindLoop('courtyard:other', 8000);
    expect(generateWindLoop('courtyard:low', 16000)).toEqual(original);
    expect(generateWindLoop('courtyard:high', 16000)).not.toEqual(original);
  });

  it('creates bounded, DC-free, soft noise with a continuous loop seam', () => {
    const samples = generateWindLoop('winter', 32000);
    const result = stats(samples);
    expect(result.peak).toBeLessThanOrEqual(0.781);
    expect(result.rms).toBeGreaterThan(0.06);
    expect(result.rms).toBeLessThan(0.35);
    expect(Math.abs(result.mean)).toBeLessThan(1e-6);
    expect(samples[0]).toBe(samples.at(-1));
    // White noise's first-difference energy is around 2x its energy. Wind needs
    // much less high-frequency energy even before the Web Audio filter stage.
    expect(result.differenceEnergyRatio).toBeLessThan(0.3);
  });

  it('keeps timber events sparse and free of clipped values or seam impulses', () => {
    const samples = generateTimberLoop('winter', 16000, 4);
    const result = stats(samples);
    expect(result.peak).toBeLessThan(0.6);
    expect(result.rms).toBeGreaterThan(0.001);
    expect(result.rms).toBeLessThan(0.08);
    expect(samples[0]).toBe(0);
    expect(samples.at(-1)).toBe(0);
    expect(samples.filter((sample) => sample === 0).length / samples.length).toBeGreaterThan(0.75);
    expect(generateTimberLoop('winter', 16000, 4)).toEqual(samples);
  });

  it('rejects unusable synthesis dimensions instead of allocating invalid buffers', () => {
    expect(() => generateWindLoop('winter', 0)).toThrow(RangeError);
    expect(() => generateWindLoop('winter', Number.NaN)).toThrow(RangeError);
    expect(() => generateTimberLoop('winter', 0)).toThrow(RangeError);
    expect(() => generateTimberLoop('winter', 16000, Number.NaN)).toThrow(RangeError);
  });
});
