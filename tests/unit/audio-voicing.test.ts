import { describe, expect, it } from 'vitest';
import type { EnvironmentSnapshot } from '../../src/core/types';
import { createWindVoicing } from '../../src/audio/windVoicing';

function frame(elapsed: number, strength = 0.3, gust = 0): EnvironmentSnapshot {
  return { elapsed, delta: 1 / 60, wind: { x: 0.5, y: 0, z: 0.1, strength }, snowIntensity: 0.72, gust, reducedMotion: false };
}

describe('weather-driven sound detail', () => {
  it('is reproducible from world time and seed rather than update count', () => {
    const first = createWindVoicing('snow');
    const second = createWindVoicing('snow');
    for (let elapsed = 0; elapsed < 40; elapsed += 1 / 30) first(frame(elapsed));
    expect(first(frame(40))).toEqual(second({ ...frame(40), delta: 1 / 12 }));
    expect(first(frame(40))).not.toEqual(createWindVoicing('another-scene')(frame(40)));
  });

  it('adds subtle movement to a steady wind while preserving wind strength and direction', () => {
    const voice = createWindVoicing('snow');
    expect(voice(frame(0)).airPan).not.toBe(voice(frame(12)).airPan);
    expect(voice(frame(0)).airBand).not.toBe(voice(frame(12)).airBand);
    expect(voice(frame(8, 0.9, 0.8)).lowGain).toBeGreaterThan(voice(frame(8, 0.1)).lowGain);
    const right = { ...frame(8), wind: { ...frame(8).wind, x: 3 } };
    const left = { ...frame(8), wind: { ...frame(8).wind, x: -3 } };
    expect(voice(right).airPan).toBeGreaterThan(voice(left).airPan);
  });

  it('keeps amplitudes, pan and playback rate within restrained bounds', () => {
    const voice = createWindVoicing('snow');
    for (let time = 0; time < 420; time += 1.3) {
      const values = voice(frame(time, 0.5 + Math.sin(time) * 0.5, 0.5 + Math.cos(time * 0.7) * 0.5));
      expect(Object.values(values).every(Number.isFinite)).toBe(true);
      for (const amplitude of [values.lowGain, values.airGain, values.timberGain]) {
        expect(amplitude).toBeGreaterThanOrEqual(0);
        expect(amplitude).toBeLessThan(0.4);
      }
      for (const pan of [values.lowPan, values.airPan, values.timberPan]) expect(Math.abs(pan)).toBeLessThan(0.9);
      for (const rate of [values.lowRate, values.airRate, values.timberRate]) {
        expect(rate).toBeGreaterThan(0.9);
        expect(rate).toBeLessThan(1.04);
      }
    }
  });
});
