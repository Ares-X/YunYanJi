import { createRandom } from '../core/random';
import type { EnvironmentSnapshot } from '../core/types';

/** One weather sample controls a distant storm and the sheltered, nearby fire. */
export function createRainfireVoicing(seed: string) {
  const random = createRandom(`${seed}:rainfire-motion`);
  const phases = Array.from({ length: 4 }, () => random() * Math.PI * 2);
  return (frame: EnvironmentSnapshot) => {
    const strength = Math.min(1, Math.max(0, frame.wind.strength));
    const gust = Math.min(1, Math.max(0, frame.gust));
    const rain = Math.min(1, Math.max(0, frame.precipitation));
    const rainBed = rain ** 0.78;
    const direction = Math.max(-1, Math.min(1, frame.wind.x * 0.28));
    const time = frame.elapsed;
    const eddy = Math.sin(time * 0.37 + phases[0]!) * 0.58 + Math.sin(time * 0.123 + phases[1]!) * 0.42;
    const flutter = Math.sin(time * 0.83 + phases[2]!) * 0.6 + Math.sin(time * 0.47 + phases[3]!) * 0.4;
    const flame = Math.sin(time * 1.13 + phases[1]!) * 0.55 + Math.sin(time * 2.17 + phases[2]!) * 0.45;
    return {
      lowGain: (0.07 + strength * 0.16 + gust * 0.035) * (1 + eddy * 0.055),
      airGain: (0.023 + strength * 0.065 + gust * 0.025) * (1 + flutter * 0.09),
      lowPan: -0.24 + direction * 0.26 + eddy * 0.055,
      airPan: 0.30 + direction * 0.25 - eddy * 0.075,
      lowRate: 1 + eddy * 0.008 + gust * 0.012,
      airRate: 1 - flutter * 0.009 + strength * 0.018,
      rainLeftGain: rainBed * (0.32 + strength * 0.11) * (1 + eddy * 0.06),
      rainRightGain: rainBed * (0.29 + strength * 0.10) * (1 - flutter * 0.055),
      rainLeftPan: -0.68 + direction * 0.08,
      rainRightPan: 0.66 + direction * 0.08,
      dropGain: rain * (0.105 + strength * 0.045) * (1 + flutter * 0.07),
      roofGain: rain * (0.085 + gust * 0.055) * (1 - eddy * 0.07),
      dropPan: 0.26 + direction * 0.11,
      roofPan: -0.38 + direction * 0.08,
      fireGain: 0.26 + flame * 0.022 + gust * 0.012,
      emberGain: 0.025 + flame * 0.004 + strength * 0.008,
      firePan: -0.13 + flutter * 0.012,
    };
  };
}
