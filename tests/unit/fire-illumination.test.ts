import { BufferGeometry, Material, Mesh, Points, ShaderMaterial, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { createCampfire } from '../../src/scenes/rainfire/campfire';
import { createFireIllumination } from '../../src/scenes/rainfire/fireIllumination';

describe('shared combustion illumination', () => {
  it('gives identical light after a seek, skipped frames and different update rates', () => {
    const direct = createFireIllumination('rainfire-01');
    direct.update(37.25, .63, -.21);
    for (const fps of [15, 30, 60, 144]) {
      const sampled = createFireIllumination('rainfire-01');
      const output = sampled.state;
      for (let frame = 0; frame < 12 * fps; frame++) sampled.update(frame / fps, 0, 0);
      sampled.update(37.25, .63, -.21);
      expect(sampled.state).toBe(output);
      expect(sampled.state).toEqual(direct.state);
      sampled.update(150, -1, 1);
      sampled.update(37.25, .63, -.21);
      expect(sampled.state).toEqual(direct.state);
    }
    const other = createFireIllumination('a-different-fire');
    other.update(37.25, .63, -.21);
    expect(other.state).not.toEqual(direct.state);
  });

  it('keeps a continuous, warm, centimetre-scale source above the fuel bed', () => {
    const fire = createFireIllumination('rainfire-01');
    let minEnergy = Infinity, maxEnergy = -Infinity;
    for (let step = 0; step < 2400; step++) {
      const elapsed = step * .05;
      fire.update(elapsed, 1.5, -1);
      const energy = fire.state.intensity;
      minEnergy = Math.min(minEnergy, energy); maxEnergy = Math.max(maxEnergy, energy);
      expect(Object.values(fire.state).every(Number.isFinite)).toBe(true);
      expect(energy).toBeGreaterThan(4); expect(energy).toBeLessThan(10);
      expect(Math.abs(fire.state.localX)).toBeLessThan(.06);
      expect(Math.abs(fire.state.localZ)).toBeLessThan(.05);
      expect(fire.state.localY).toBeGreaterThan(.48); expect(fire.state.localY).toBeLessThan(.65);
      expect(fire.state.height).toBeGreaterThan(.65); expect(fire.state.height).toBeLessThan(1.12);
      expect(fire.state.red).toBeGreaterThan(fire.state.green);
      expect(fire.state.green).toBeGreaterThan(fire.state.blue);
      fire.update(elapsed + .001, 1.5, -1);
      expect(Math.abs(fire.state.intensity - energy)).toBeLessThan(.03);
    }
    expect(maxEnergy - minEnergy).toBeGreaterThan(1);
  });

  it('shares light position and energy with the flame and smoke without replacing uniforms', () => {
    const fire = createCampfire('rainfire-01', 'medium');
    const volume = fire.group.getObjectByName('fire-volume') as Mesh<BufferGeometry, ShaderMaterial>;
    const position = volume.material.uniforms.uFirePosition!.value;
    const color = volume.material.uniforms.uFireColor!.value;
    try {
      for (const elapsed of [0, 3.7, 25, 3.7]) {
        fire.update({ elapsed, delta: 1 / 60, wind: { x: .6, y: 0, z: -.2, strength: .7 },
          precipitation: .8, gust: .2, reducedMotion: false });
        const energy=fire.lights.reduce((sum,light)=>sum+light.intensity,0);
        const centroid=fire.lights.reduce((point,light)=>point.addScaledVector(light.position,light.intensity),
          new Vector3()).multiplyScalar(1/energy);
        expect(energy).toBeCloseTo(fire.illumination.intensity,12);
        expect(volume.material.uniforms.uFireIntensity!.value).toBeCloseTo(energy,12);
        expect(volume.material.uniforms.uFlameHeight!.value).toBe(fire.illumination.height);
        expect(volume.material.uniforms.uFirePosition!.value).toBe(position);
        expect(volume.material.uniforms.uFireColor!.value).toBe(color);
        expect(position.distanceTo(centroid)).toBeLessThan(1e-12);
        expect(color.equals(fire.light.color)).toBe(true);
      }
      const sample = { ...fire.illumination };
      for (const quality of ['low', 'high', 'medium'] as const) fire.setQuality(quality);
      expect(fire.illumination).toEqual(sample);
    } finally {
      const geometries = new Set<BufferGeometry>(), materials = new Set<Material>();
      fire.group.traverse(object => {
        if (!(object instanceof Mesh || object instanceof Points)) return;
        geometries.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      });
      geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose());
      fire.lights.forEach(light=>light.dispose());
    }
  });
});
