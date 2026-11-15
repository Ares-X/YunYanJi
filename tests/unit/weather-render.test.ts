import { describe, expect, it } from 'vitest';
import { Mesh, Points, ShaderMaterial, Vector3 } from 'three';
import { WeatherSimulation } from '../../src/core/WeatherSimulation';
import { weatherLighting } from '../../src/render/weatherLighting';
import { createRainAtmosphere } from '../../src/render/RainAtmosphere';
import { createRainParticles } from '../../src/scenes/rainfire/rainParticles';
import type { WeatherMode } from '../../src/core/types';

function disposeParticles(group: ReturnType<typeof createRainParticles>['group']): void {
  group.traverse(object => {
    if (!(object instanceof Mesh || object instanceof Points)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
  });
}

describe('shared weather reaches the rendered world', () => {
  it('separates clear, overcast and storm energy, and lights the scene during a strike', () => {
    const simulation = new WeatherSimulation('weather-light');
    const readings = new Map<WeatherMode, ReturnType<typeof weatherLighting>>();
    for (const mode of ['clear', 'overcast', 'drizzle', 'rain', 'downpour', 'snow'] as const) {
      simulation.setWeather(mode, true);
      const lighting = weatherLighting(simulation.snapshot().weather);
      readings.set(mode, lighting);
      expect(Object.values(lighting).every(Number.isFinite)).toBe(true);
      expect(lighting.environment).toBeGreaterThan(.4);
      expect(lighting.fog).toBeGreaterThan(0);
    }
    expect(readings.get('clear')!.sun).toBeGreaterThan(readings.get('overcast')!.sun * 2);
    expect(readings.get('overcast')!.sun).toBeGreaterThan(readings.get('downpour')!.sun);
    expect(readings.get('downpour')!.mist).toBeGreaterThan(readings.get('clear')!.mist * 2);
    const ordinary = weatherLighting(simulation.snapshot().weather);
    const flash = weatherLighting(simulation.snapshot().weather, .8);
    expect(flash.sun).toBeGreaterThan(ordinary.sun);
    expect(flash.environment).toBeGreaterThan(ordinary.environment);
    expect(flash.hemisphere).toBeGreaterThan(ordinary.hemisphere);
  });

  it('captures the same reference clouds then restores live weather and time', () => {
    const sky = createRainAtmosphere();
    const simulation = new WeatherSimulation('weather-sky');
    const uniforms = sky.mesh.material.uniforms;
    simulation.setWeather('clear', true);
    simulation.advance(.1);
    sky.update(simulation.snapshot());
    expect(uniforms.uDaylight!.value).toBe(1);
    sky.setEnvironmentCapture(true);
    expect(uniforms.uTime!.value).toBe(0);
    expect(uniforms.uDaylight!.value).toBe(.25);
    const referenceColor = uniforms.uHaze!.value.clone();
    sky.setEnvironmentCapture(false);
    expect(uniforms.uTime!.value).toBe(.1);
    expect(uniforms.uDaylight!.value).toBe(1);
    simulation.setWeather('downpour', true);
    simulation.triggerThunder();
    sky.update(simulation.snapshot());
    expect(uniforms.uFlash!.value).toBeGreaterThan(0);
    sky.setEnvironmentCapture(true);
    expect(uniforms.uFlash!.value).toBe(0);
    expect(uniforms.uHaze!.value.equals(referenceColor)).toBe(true);
    sky.setEnvironmentCapture(false);
    expect(uniforms.uFlash!.value).toBeGreaterThan(0);
    sky.dispose();
  });

  it('uses snow instead of liquid drops, disables precipitation in clear skies, and reuses buffers', () => {
    const precipitation = createRainParticles('precipitation-test', 'high', new Vector3(-.8, .1, -1.6));
    const simulation = new WeatherSimulation('precipitation-test');
    const rain = precipitation.group.getObjectByName('falling-rain') as Mesh;
    const snow = precipitation.group.getObjectByName('falling-snow-crystals') as Points;
    const splash = precipitation.group.getObjectByName('sparse-rain-impact-droplets') as Points;
    const original = [rain.geometry, snow.geometry, splash.geometry, rain.material, snow.material, splash.material];
    simulation.setWeather('snow', true);
    precipitation.update(simulation.snapshot());
    expect(snow.visible).toBe(true);
    expect(snow.geometry.drawRange.count).toBeGreaterThan(4000);
    expect(rain.visible).toBe(false);
    expect(splash.visible).toBe(false);
    simulation.setWeather('clear', true);
    precipitation.update(simulation.snapshot());
    expect(snow.visible || rain.visible || splash.visible).toBe(false);
    simulation.setWeather('downpour', true);
    precipitation.update(simulation.snapshot());
    expect(rain.visible).toBe(true);
    const rainGeometry = rain.geometry as import('three').InstancedBufferGeometry;
    const downpourCount = rainGeometry.instanceCount;
    simulation.setWeather('drizzle', true);
    precipitation.update(simulation.snapshot());
    expect(rainGeometry.instanceCount).toBeLessThan(downpourCount * .3);
    for (const quality of ['low', 'medium', 'high', 'low', 'high'] as const) {
      precipitation.setQuality(quality);
      precipitation.update(simulation.snapshot());
    }
    expect([rain.geometry, snow.geometry, splash.geometry, rain.material, snow.material, splash.material]).toEqual(original);
    simulation.setFireState('out', true);
    precipitation.update(simulation.snapshot());
    expect((rain.material as ShaderMaterial).uniforms.uFire!.value).toBe(0);
    expect((snow.material as ShaderMaterial).uniforms.uFire!.value).toBe(0);
    disposeParticles(precipitation.group);
  });

  it('keeps a frozen precipitation field fixed across settings redraws', () => {
    const precipitation = createRainParticles('paused-weather', 'low', new Vector3());
    const simulation = new WeatherSimulation('paused-weather');
    const rain = precipitation.group.getObjectByName('falling-rain') as Mesh;
    const uniforms = (rain.material as ShaderMaterial).uniforms;
    for (let i = 0; i < 30; i++) precipitation.update(simulation.advance(1 / 30));
    const previousFall = uniforms.uFall!.value;
    const previousAdvection = uniforms.uAdvection!.value.clone();
    for (let i = 0; i < 12; i++) precipitation.update(simulation.snapshot());
    expect(uniforms.uFall!.value).toBe(previousFall);
    expect(uniforms.uAdvection!.value.equals(previousAdvection)).toBe(true);
    disposeParticles(precipitation.group);
  });
});
