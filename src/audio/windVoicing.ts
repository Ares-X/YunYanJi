import { createRandom } from '../core/random';
import type { EnvironmentSnapshot } from '../core/types';

/** Tiny deterministic eddies enrich the same wind field, without a second clock. */
export function createWindVoicing(seed: string) {
  const random = createRandom(`${seed}:air-motion`);
  const phases = Array.from({ length: 4 }, () => random() * Math.PI * 2);
  return (frame: EnvironmentSnapshot) => {
    const strength = Math.min(1, Math.max(0, frame.wind.strength));
    const gust = Math.min(1, Math.max(0, frame.gust));
    const direction = Math.max(-1, Math.min(1, frame.wind.x * 0.28));
    const time = frame.elapsed;
    const eddy = Math.sin(time * 0.37 + (phases[0] ?? 0)) * 0.58 + Math.sin(time * 0.123 + (phases[1] ?? 0)) * 0.42;
    const flutter = Math.sin(time * 0.83 + (phases[2] ?? 0)) * 0.6 + Math.sin(time * 0.47 + (phases[3] ?? 0)) * 0.4;
    const detail = 0.2 + strength * 0.65 + gust * 0.15;
    return {
      lowGain: (0.095 + strength * 0.19 + gust * 0.035) * (1 + eddy * 0.04 * detail),
      lowpass: (320 + strength * 430) * (1 + eddy * 0.035 * detail),
      airGain: (0.025 + strength * 0.1 + gust * 0.04) * (1 + flutter * 0.1 * detail),
      airBand: (580 + strength * 610) * (1 + eddy * 0.045 * detail),
      lowPan: -0.24 + direction * 0.31 + eddy * 0.075 * detail,
      airPan: 0.3 + direction * 0.33 - eddy * 0.11 * detail,
      timberPan: -0.58 + direction * 0.12 + eddy * 0.04 * detail,
      timberGain: (0.003 + strength * 0.014 + gust * 0.01) * (1 + flutter * 0.08 * detail),
      lowRate: 1 + eddy * 0.008 * detail + gust * 0.012,
      airRate: 1 - flutter * 0.009 * detail + strength * 0.018,
      timberRate: 0.94 + strength * 0.06 + flutter * 0.008 * detail,
    };
  };
}
