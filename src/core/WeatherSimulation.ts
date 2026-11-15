import { createRandom } from './random';
import type { EnvironmentSnapshot } from './types';

/** Pure state: elapsed time, snow and a continuous, bounded wind impulse. */
export class WeatherSimulation {
  elapsed = 0;
  snowIntensity = 0.72;
  reducedMotion = false;
  private readonly phase: number;
  private gustStarted = -100;
  private gustDirection = 1;
  private gustStrength = 1;

  constructor(seed: string) {
    this.phase = createRandom(`${seed}:weather`)() * Math.PI * 2;
  }

  advance(seconds: number): EnvironmentSnapshot {
    const delta = Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, 0.1)) : 0;
    this.elapsed += delta;
    return this.snapshot(delta);
  }

  gust(direction = 1, strength = 1): void {
    this.gustStarted = this.elapsed;
    this.gustDirection = direction < 0 ? -1 : 1;
    this.gustStrength = Math.max(0.15, Math.min(1, Number.isFinite(strength) ? strength : 1));
  }

  setSnowIntensity(value: number): void {
    if (Number.isFinite(value)) this.snowIntensity = Math.max(0, Math.min(1, value));
  }

  reset(): void {
    this.elapsed = 0;
    this.gustStarted = -100;
  }

  snapshot(delta = 0): EnvironmentSnapshot {
    const age = this.elapsed - this.gustStarted;
    // Zero at both ends; a rise, a little lift, and a long release.
    const pulse = age >= 0 && age < 7 ? Math.sin(Math.min(age / 7, 1) * Math.PI) ** 2 : 0;
    const gust = pulse * this.gustStrength;
    const drift = 0.45 + Math.sin(this.elapsed * 0.21 + this.phase) * 0.16;
    return {
      elapsed: this.elapsed,
      delta,
      wind: {
        x: drift + gust * this.gustDirection * 2.2,
        y: 0.08 + gust * 0.55,
        z: 0.12 + Math.sin(this.elapsed * 0.13 + this.phase) * 0.14,
        strength: Math.min(1, 0.16 + drift * 0.15 + gust * 0.73),
      },
      snowIntensity: this.snowIntensity,
      gust,
      reducedMotion: this.reducedMotion,
    };
  }
}
