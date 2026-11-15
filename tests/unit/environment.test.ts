import { describe, expect, it } from 'vitest';
import { WeatherSimulation } from '../../src/core/WeatherSimulation';
import { createRandom } from '../../src/core/random';
import { DEFAULT_SEED, readSeed, sceneLink } from '../../src/core/location';
import { drawingSize, resolveQuality } from '../../src/render/quality';

describe('reproducible shared environments', () => {
  it('produces independent deterministic streams, including Unicode seeds', () => {
    const a = createRandom('云烟:geometry');
    const b = createRandom('云烟:geometry');
    const sound = createRandom('云烟:sound');
    const values = Array.from({ length: 128 }, () => a());
    expect(Array.from({ length: 128 }, () => b())).toEqual(values);
    expect(Array.from({ length: 128 }, () => sound())).not.toEqual(values);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it('samples the same wind after equal elapsed time at 30 and 120 fps', () => {
    const slow = new WeatherSimulation('snow');
    const fast = new WeatherSimulation('snow');
    slow.gust(-1); fast.gust(-1);
    for (let i = 0; i < 90; i++) slow.advance(1 / 30);
    for (let i = 0; i < 360; i++) fast.advance(1 / 120);
    expect(slow.snapshot().wind.x).toBeCloseTo(fast.snapshot().wind.x, 9);
    expect(slow.snapshot().gust).toBeCloseTo(fast.snapshot().gust, 9);
    expect(slow.snapshot().gust).toBeGreaterThan(0.8);
  });

  it('bounds resumed-tab deltas and expires wind impulses', () => {
    const world = new WeatherSimulation('snow');
    world.gust();
    world.advance(500);
    expect(world.elapsed).toBe(0.1);
    world.advance(Number.NaN);
    expect(world.elapsed).toBe(0.1);
    for (let i = 0; i < 240; i++) world.advance(1 / 30);
    expect(world.snapshot().gust).toBe(0);
    world.reset();
    expect(world.snapshot().wind).toEqual(new WeatherSimulation('snow').snapshot().wind);
  });
});

describe('URLs and quality budgets', () => {
  it('rejects unsafe/oversized seeds and shares only world identity', () => {
    expect(readSeed('?seed=%3Cimg%3E')).toBe(DEFAULT_SEED);
    expect(readSeed('?seed=' + 'x'.repeat(65))).toBe(DEFAULT_SEED);
    expect(readSeed('?seed=雪庭-01')).toBe('雪庭-01');
    const link = new URL(sceneLink('https://example.com/YunYanJi/?debug=1&seed=old#test', 'snow-01'));
    expect(link.search).toBe('?seed=snow-01');
    expect(link.pathname).toBe('/YunYanJi/');
    expect(link.hash).toBe('');
  });

  it('caps high-density rendering and keeps explicit quality choices', () => {
    const { width, height } = drawingSize(3840, 2160, 3, 'medium');
    expect(width * height).toBeLessThanOrEqual(1_500_000);
    expect(drawingSize(3840, 2160, 1, 'high')).toEqual({ width: 3840, height: 2160 });
    const high = drawingSize(3840, 2160, 3, 'high');
    expect(high.width * high.height).toBeLessThanOrEqual(8_294_400);
    expect(resolveQuality('auto', 390, true)).toBe('medium');
    expect(resolveQuality('low', 1920, false)).toBe('low');
  });
});
