import { describe, expect, it } from 'vitest';
import { WeatherSimulation, WEATHER_PRESETS } from '../../src/core/WeatherSimulation';
import type { WeatherMode } from '../../src/core/types';

function advance(world: WeatherSimulation, seconds: number, fps = 60): void {
  for (let frame = 0; frame < Math.round(seconds * fps); frame++) world.advance(1 / fps);
}

describe('weather, thunder and fire on one simulation clock', () => {
  it('offers distinct bounded presets and switches the kind of precipitation', () => {
    const world = new WeatherSimulation('all-weather');
    for (const mode of Object.keys(WEATHER_PRESETS) as WeatherMode[]) {
      world.setWeather(mode, true);
      const frame = world.snapshot();
      expect(frame.weather.mode).toBe(mode);
      for (const key of ['rain', 'snow', 'cloudCover', 'daylight', 'storm'] as const) {
        expect(frame.weather[key]).toBe(WEATHER_PRESETS[mode][key]);
        expect(frame.weather[key]).toBeGreaterThanOrEqual(0);
        expect(frame.weather[key]).toBeLessThanOrEqual(1);
      }
      expect(frame.precipitation).toBe(frame.weather.rain);
      expect(frame.weather.rain * frame.weather.snow).toBe(0);
    }
    expect(WEATHER_PRESETS.drizzle.rain).toBeLessThan(WEATHER_PRESETS.rain.rain);
    expect(WEATHER_PRESETS.rain.rain).toBeLessThan(WEATHER_PRESETS.downpour.rain);
    expect(world.snapshot().weather.snowCover).toBeGreaterThan(.3);
  });

  it('crossfades in real simulation seconds, preserving wet ground and melting snow slowly', () => {
    const world = new WeatherSimulation('weather-transition');
    world.setWeather('snow');
    expect(world.snapshot().weather.rain).toBe(.72);
    expect(world.snapshot().weather.snow).toBe(0);
    advance(world, 1);
    expect(world.snapshot().weather.rain).toBeGreaterThan(0);
    expect(world.snapshot().weather.snow).toBeGreaterThan(0);
    advance(world, 60);
    expect(world.snapshot().weather.rain).toBe(0);
    const snow = world.snapshot().weather.snowCover;
    const wet = world.snapshot().weather.wetness;
    expect(snow).toBeGreaterThan(.4);
    world.setWeather('clear', true);
    expect(world.snapshot().weather.snowCover).toBe(snow);
    expect(world.snapshot().weather.wetness).toBe(wet);
    advance(world, 30);
    expect(world.snapshot().weather.snowCover).toBeLessThan(snow);
    expect(world.snapshot().weather.snowCover).toBeGreaterThan(0);
    expect(world.snapshot().weather.wetness).toBeLessThan(wet);
  });

  it('keeps weather and fuel consistent across frame rates, and snapshots do not advance anything', () => {
    const slow = new WeatherSimulation('shared-clock'), fast = new WeatherSimulation('shared-clock');
    for (const world of [slow, fast]) { world.setWeather('downpour'); world.setFireState('roaring'); world.addWood(); }
    advance(slow, 9, 30); advance(fast, 9, 120);
    expect(slow.snapshot().weather.rain).toBeCloseTo(fast.snapshot().weather.rain, 9);
    expect(slow.snapshot().fire.fuel).toBeCloseTo(fast.snapshot().fire.fuel, 9);
    expect(slow.snapshot().fire.flame).toBeCloseTo(fast.snapshot().fire.flame, 9);
    const still = slow.snapshot();
    for (let i = 0; i < 90; i++) expect(slow.snapshot()).toEqual(still);
  });

  it('lets light arrive before thunder and protects a pending distant clap from repeated actions', () => {
    let world: WeatherSimulation | undefined;
    for (let index = 0; index < 64; index++) {
      const candidate = new WeatherSimulation(`distant-${index}`);
      candidate.triggerThunder();
      if (candidate.snapshot().lightning!.delay > 3.5) { world = candidate; break; }
    }
    expect(world).toBeDefined();
    const strike = world!.snapshot().lightning!;
    expect(strike.flash).toBeGreaterThan(0);
    expect(strike.delay).toBeCloseTo(strike.distance / 343);
    advance(world!, 3.2);
    expect(world!.snapshot().lightning!.flash).toBe(0);
    expect(world!.triggerThunder()).toBe(false);
    expect(world!.snapshot().lightning!.id).toBe(strike.id);
    advance(world!, 1.3);
    expect(world!.triggerThunder()).toBe(true);
    world!.reducedMotion = true;
    expect(world!.snapshot().lightning!.flash).toBe(0);
    expect(world!.snapshot().lightning!.intensity).toBeGreaterThan(0);
  });

  it('generates repeatable occasional thunder and cancels future events when disabled', () => {
    const first = new WeatherSimulation('storm-events'), second = new WeatherSimulation('storm-events');
    for (const world of [first, second]) { world.setWeather('downpour', true); advance(world, 22); }
    expect(first.snapshot().lightning).toEqual(second.snapshot().lightning);
    expect(first.snapshot().lightning).not.toBeNull();
    first.setAutomaticThunder(false);
    const event = first.snapshot().lightning!.id;
    advance(first, 100);
    expect(first.snapshot().lightning!.id).toBe(event);
    first.reset();
    first.setWeather('downpour', true); advance(first, 22);
    expect(first.snapshot().lightning).toEqual(second.snapshot().lightning);
  });

  it('adds visible wood while paused, bounds repeated feeding and does not light a cold hearth', () => {
    const world = new WeatherSimulation('cold-hearth');
    world.setFireState('out', true);
    for (let i = 0; i < 4; i++) expect(world.addWood()).toBe(true);
    for (let i = 0; i < 12; i++) expect(world.addWood()).toBe(false);
    const cold = world.snapshot();
    expect(cold.elapsed).toBe(0);
    expect(cold.fire).toMatchObject({ state: 'out', addedLogs: 4, fuel: 1, flame: 0, heat: 0, embers: 0 });
    world.setFireState('small');
    advance(world, 4);
    expect(world.snapshot().fire.flame).toBeGreaterThan(0);
    expect(world.snapshot().fire.fuel).toBeLessThan(1);
    world.reset();
    expect(world.snapshot().fire).toMatchObject({ state: 'steady', fuel: .66, addedLogs: 0, feedId: 0 });
    expect(world.snapshot().weather.mode).toBe('rain');
    expect(world.snapshot().lightning).toBeNull();
  });

  it('keeps embers without flames and catches fresh fuel over time', () => {
    const world = new WeatherSimulation('embers');
    world.setFireState('embers', true);
    expect(world.snapshot().fire.flame).toBe(0);
    expect(world.snapshot().fire.embers).toBeGreaterThan(0);
    world.addWood();
    const newlyFed = world.snapshot().fire;
    expect(newlyFed.state).toBe('small');
    advance(world, 4);
    expect(world.snapshot().fire.flame).toBeGreaterThan(newlyFed.flame);
    expect(world.snapshot().fire.smoke).toBeLessThan(newlyFed.smoke);
    world.setFireState('out');
    expect(world.snapshot().fire).toMatchObject({ flame: 0, heat: 0, embers: 0 });
  });
});
