import { hashSeed } from '../../core/random';
import type { FireSnapshot } from '../../core/types';

/** One combustion sample, in metres relative to the hearth and linear RGB. */
export interface FireIlluminationState {
  localX: number;
  localY: number;
  localZ: number;
  intensity: number;
  red: number;
  green: number;
  blue: number;
  height: number;
  heat: number;
  coalHeat: number;
  smoke: number;
}

export interface FireIllumination {
  readonly state: Readonly<FireIlluminationState>;
  update(elapsed: number, windX: number, windZ: number, fire?: FireSnapshot): void;
}

function lattice(index: number, seed: number): number {
  let value = Math.imul(index ^ seed, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff * 2 - 1;
}

/** Continuous value noise, addressed by time rather than by animation frames. */
function drift(time: number, seed: number): number {
  const index = Math.floor(time), fraction = time - index;
  const weight = fraction * fraction * fraction * (fraction * (fraction * 6 - 15) + 10);
  const left = lattice(index, seed);
  return left + (lattice(index + 1, seed) - left) * weight;
}

/**
 * Fuel release, draft and small eddies share one deterministic envelope. There
 * is no advancing RNG or filter state: seeking, pausing and skipped frames all
 * produce the same fire. The output object is allocated once and updated in place.
 */
export function createFireIllumination(seed: string): FireIllumination {
  const identity = hashSeed(`${seed}/combustion`);
  const state: FireIlluminationState = {
    localX: 0, localY: .56, localZ: 0, intensity: 6.8,
    red: 1, green: .42, blue: .145,
    height: .84, heat: 1, coalHeat: 1, smoke: 1,
  };
  const update = (elapsed: number, windX: number, windZ: number, fire?: FireSnapshot): void => {
    const fuel = drift(elapsed * .47 + 13.1, identity);
    const draft = drift(elapsed * 1.83 + 29.4, identity ^ 0x792d);
    const eddy = drift(elapsed * 6.7 + 7.2, identity ^ 0x39a1);
    const burst = Math.max(0, drift(elapsed * .89 + 83.6, identity ^ 0x6f25) - .27);
    const heat = .96 + fuel * .12 + draft * .08 + eddy * .025 + burst * burst * .15;
    const bank = drift(elapsed * .16 + 31.7, identity ^ 0x5b97);
    // The historical steady fire is the reference exposure. Shared simulation
    // strengths scale this same envelope, so extinguishing cannot leave an
    // independent light, luminous log crack or shower of sparks running.
    const flame = fire ? Math.max(0, Math.min(1.65, fire.flame / .62)) : 1;
    const ember = fire ? Math.max(0, Math.min(1.3, fire.embers / .78)) : 1;
    const smoke = fire ? Math.max(0, Math.min(2.5, fire.smoke / .229)) : 1;
    state.heat = heat * flame;
    state.height = (.84 + fuel * .075 + draft * .055 + burst * burst * .13)
      * Math.pow(flame, .68);
    state.coalHeat = (.97 + bank * .10 + fuel * .045) * ember;
    state.smoke = (.96 - fuel * .16 - burst * .10 + bank * .08) * smoke;
    // The centroid only drifts centimetres. Flame bases stay attached to wood;
    // upper tongues lean toward this same moving source of illumination.
    state.localX = drift(elapsed * .73 + 47.1, identity ^ 0x134f) * .024
      + Math.max(-1.5, Math.min(1.5, windX)) * .018;
    state.localZ = drift(elapsed * .61 + 59.3, identity ^ 0x2c71) * .022
      + Math.max(-1, Math.min(1, windZ)) * .018;
    state.localY = .55 + (state.height - .84) * .32 + draft * .010 * Math.min(flame, 1);
    state.intensity = 6.8 * heat * Math.pow(flame, 1.22);
    state.red = 1;
    state.green = .42 + (heat - .96) * .15;
    state.blue = .145 + (heat - .96) * .07;
  };
  update(0, .45, .12);
  return { state, update };
}
