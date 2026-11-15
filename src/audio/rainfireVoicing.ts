import { createRandom } from '../core/random';
import type { EnvironmentSnapshot } from '../core/types';

/** One weather sample controls a distant storm and the sheltered, nearby fire. */
export function createRainfireVoicing(seed: string) {
  const random = createRandom(`${seed}:rainfire-motion`);
  const phases = Array.from({ length: 4 }, () => random() * Math.PI * 2);
  return (frame: EnvironmentSnapshot) => {
    const strength = Math.min(1, Math.max(0, frame.wind.strength));
    const gust = Math.min(1, Math.max(0, frame.gust));
    const rain = Math.min(1, Math.max(0, frame.weather.rain));
    const snow = Math.min(1, Math.max(0, frame.weather.snow));
    // Drizzle leaves room between close impacts; heavy rain fills the forest.
    const rainBed = rain ** 1.25;
    const snowMuffle = 1 - snow * 0.16;
    const direction = Math.max(-1, Math.min(1, frame.wind.x * 0.28));
    const time = frame.elapsed;
    const eddy = Math.sin(time * 0.37 + phases[0]!) * 0.58 + Math.sin(time * 0.123 + phases[1]!) * 0.42;
    const flutter = Math.sin(time * 0.83 + phases[2]!) * 0.6 + Math.sin(time * 0.47 + phases[3]!) * 0.4;
    const flame = Math.min(1, Math.max(0, frame.fire.flame));
    const ember = Math.min(1, Math.max(0, frame.fire.embers));
    const feedBreath = frame.fire.feedId > 0 ? Math.exp(-Math.max(0, frame.fire.feedAge) / 2.4) : 0;
    return {
      lowGain: (0.055 + strength * 0.16 + gust * 0.035) * (1 + eddy * 0.055) * snowMuffle,
      airGain: (0.018 + strength * 0.065 + gust * 0.025) * (1 + flutter * 0.09) * snowMuffle,
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
      dropRate: 0.5 + rain * 0.65,
      roofRate: 0.55 + rain * 0.55,
      snowGain: snow * (0.035 + strength * 0.025) * (1 + flutter * 0.08),
      snowPan: -0.20 + direction * 0.15,
      fireGain: flame * (0.30 + feedBreath * 0.025 + gust * 0.012),
      emberGain: ember * (0.018 + flame * 0.018 + strength * 0.004),
      firePan: -0.13 + flutter * 0.012,
    };
  };
}
