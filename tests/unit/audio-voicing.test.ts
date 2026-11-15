import { describe, expect, it } from 'vitest';
import type { EnvironmentSnapshot } from '../../src/core/types';
import { createRainfireVoicing } from '../../src/audio/rainfireVoicing';

function frame(elapsed: number, strength = 0.3, gust = 0): EnvironmentSnapshot {
  return { elapsed, delta: 1 / 60, wind: { x: 0.5, y: 0, z: 0.1, strength }, precipitation: 0.72, gust, reducedMotion: false };
}

describe('weather-driven sound detail', () => {
  it('is reproducible from world time and seed rather than update count', () => {
    const first = createRainfireVoicing('rainfire');
    const second = createRainfireVoicing('rainfire');
    for (let elapsed = 0; elapsed < 40; elapsed += 1 / 30) first(frame(elapsed));
    expect(first(frame(40))).toEqual(second({ ...frame(40), delta: 1 / 12 }));
    expect(first(frame(40))).not.toEqual(createRainfireVoicing('another-scene')(frame(40)));
  });

  it('adds subtle movement to a steady wind while preserving wind strength and direction', () => {
    const voice = createRainfireVoicing('rainfire');
    expect(voice(frame(0)).airPan).not.toBe(voice(frame(12)).airPan);
    expect(voice(frame(0)).airRate).not.toBe(voice(frame(12)).airRate);
    expect(voice(frame(8, 0.9, 0.8)).lowGain).toBeGreaterThan(voice(frame(8, 0.1)).lowGain);
    const right = { ...frame(8), wind: { ...frame(8).wind, x: 3 } };
    const left = { ...frame(8), wind: { ...frame(8).wind, x: -3 } };
    expect(voice(right).airPan).toBeGreaterThan(voice(left).airPan);
  });

  it('connects rain layers to precipitation while the sheltered fire keeps burning', () => {
    const voice = createRainfireVoicing('rainfire');
    const dry = voice({ ...frame(8), precipitation: 0 });
    const rainy = voice({ ...frame(8), precipitation: 1 });
    for (const level of [dry.rainLeftGain, dry.rainRightGain, dry.dropGain, dry.roofGain]) expect(level).toBe(0);
    for (const level of [rainy.rainLeftGain, rainy.rainRightGain, rainy.dropGain, rainy.roofGain]) expect(level).toBeGreaterThan(0.07);
    expect(dry.fireGain).toBe(rainy.fireGain);
    expect(dry.emberGain).toBe(rainy.emberGain);
    expect(dry.lowGain).toBe(rainy.lowGain);
    // Widely separated rain, narrower distant wind, and a close fixed hearth.
    expect(rainy.rainRightPan - rainy.rainLeftPan).toBeGreaterThan(1.2);
    expect(Math.abs(rainy.firePan)).toBeLessThan(0.2);
  });

  it('keeps amplitudes, pan and playback rate within restrained bounds', () => {
    const voice = createRainfireVoicing('rainfire');
    for (let time = 0; time < 420; time += 1.3) {
      const values = voice(frame(time, 0.5 + Math.sin(time) * 0.5, 0.5 + Math.cos(time * 0.7) * 0.5));
      expect(Object.values(values).every(Number.isFinite)).toBe(true);
      for (const amplitude of [values.lowGain, values.airGain, values.fireGain, values.emberGain]) {
        expect(amplitude).toBeGreaterThanOrEqual(0);
        expect(amplitude).toBeLessThan(0.4);
      }
      for (const amplitude of [values.rainLeftGain, values.rainRightGain, values.dropGain, values.roofGain]) {
        expect(amplitude).toBeGreaterThanOrEqual(0);
        expect(amplitude).toBeLessThan(0.5);
      }
      for (const pan of [values.lowPan, values.airPan, values.firePan, values.rainLeftPan, values.rainRightPan,
        values.dropPan, values.roofPan]) expect(Math.abs(pan)).toBeLessThan(0.9);
      for (const rate of [values.lowRate, values.airRate]) {
        expect(rate).toBeGreaterThan(0.9);
        expect(rate).toBeLessThan(1.04);
      }
    }
  });
});
