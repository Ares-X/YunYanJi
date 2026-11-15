import { createRandom } from './random';
import { CampfireSimulation } from './CampfireSimulation';
import type { EnvironmentSnapshot, FireState, LightningSnapshot, WeatherMode } from './types';

interface Conditions { rain: number; snow: number; cloudCover: number; daylight: number; storm: number }
export const WEATHER_PRESETS: Readonly<Record<WeatherMode, Readonly<Conditions>>> = {
  clear: { rain: 0, snow: 0, cloudCover: .16, daylight: 1, storm: 0 },
  overcast: { rain: 0, snow: 0, cloudCover: .96, daylight: .48, storm: 0 },
  drizzle: { rain: .22, snow: 0, cloudCover: .82, daylight: .40, storm: .03 },
  rain: { rain: .72, snow: 0, cloudCover: .90, daylight: .25, storm: .22 },
  downpour: { rain: 1, snow: 0, cloudCover: 1, daylight: .12, storm: 1 },
  snow: { rain: 0, snow: .78, cloudCover: .94, daylight: .45, storm: .10 },
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Shared, seeded simulation clock: skies, precipitation, lightning, fuel and sound. */
export class WeatherSimulation {
  elapsed = 0;
  reducedMotion = false;
  private readonly phase: number;
  private readonly seed: string;
  private randomThunder: () => number;
  private gustStarted = -100;
  private gustDirection = 1;
  private gustStrength = 1;
  private mode: WeatherMode = 'rain';
  private current: Conditions = { ...WEATHER_PRESETS.rain };
  private target: Conditions = { ...WEATHER_PRESETS.rain };
  private wetness = .88;
  private snowCover = 0;
  private revision = 0;
  private automaticThunder = false;
  private nextThunder = Infinity;
  private strikeId = 0;
  private strike: { id: number; time: number; distance: number; intensity: number; pan: number } | null = null;
  private readonly campfire = new CampfireSimulation();

  constructor(seed: string) {
    this.seed = seed;
    this.phase = createRandom(`${seed}:weather`)() * Math.PI * 2;
    this.randomThunder = createRandom(`${seed}:thunder-events`);
  }

  /** Compatibility for callers interested specifically in liquid precipitation. */
  get precipitation(): number { return this.current.rain; }

  advance(seconds: number): EnvironmentSnapshot {
    const delta = Number.isFinite(seconds) ? Math.max(0, Math.min(seconds, .1)) : 0;
    this.elapsed += delta;
    const approach = 1 - Math.exp(-delta / 1.3);
    for (const key of Object.keys(this.current) as (keyof Conditions)[]) {
      this.current[key] += (this.target[key] - this.current[key]) * approach;
      if (Math.abs(this.target[key] - this.current[key]) < .0001) this.current[key] = this.target[key];
    }
    const wetTarget = this.current.rain > .05 ? .7 + this.current.rain * .3 : .14;
    this.wetness += (wetTarget - this.wetness) * (1 - Math.exp(-delta / (this.current.rain > .05 ? 25 : 180)));
    const snowTarget = this.current.snow * .70;
    this.snowCover += (snowTarget - this.snowCover) * (1 - Math.exp(-delta / (this.current.snow > .05 ? 35 : 90)));
    this.campfire.advance(delta, this.elapsed);
    if (this.automaticThunder && this.elapsed >= this.nextThunder) this.triggerThunder();
    return this.snapshot(delta);
  }

  gust(direction = 1, strength = 1): void {
    this.gustStarted = this.elapsed;
    this.gustDirection = direction < 0 ? -1 : 1;
    this.gustStrength = Math.max(.15, Math.min(1, Number.isFinite(strength) ? strength : 1));
  }

  setWeather(mode: WeatherMode, immediate = false): void {
    if (!(mode in WEATHER_PRESETS)) return;
    this.mode = mode; this.target = { ...WEATHER_PRESETS[mode] }; this.revision += 1;
    if (immediate) {
      this.current = { ...this.target };
      if (mode === 'snow') this.snowCover = Math.max(.40, this.snowCover);
    }
    this.setAutomaticThunder(mode === 'downpour');
  }

  setPrecipitation(value: number): void {
    if (!Number.isFinite(value)) return;
    const amount = clamp(value);
    if (this.mode === 'snow') this.current.snow = this.target.snow = amount;
    else {
      if ((this.mode === 'clear' || this.mode === 'overcast') && amount > 0) this.setWeather('rain', true);
      this.current.rain = this.target.rain = amount;
    }
    this.revision += 1;
  }

  setAutomaticThunder(enabled: boolean): void {
    this.automaticThunder = enabled;
    this.nextThunder = enabled ? this.elapsed + 12 + this.randomThunder() * 9 : Infinity;
    this.revision += 1;
  }

  /** A held key cannot strobe or replace a strike before its thunder arrives. */
  triggerThunder(): boolean {
    if (this.strike && this.elapsed - this.strike.time < Math.max(3, this.strike.distance / 343 + .15)) return false;
    this.strike = { id: ++this.strikeId, time: this.elapsed,
      distance: 380 + this.randomThunder() * 1040,
      intensity: .65 + this.randomThunder() * .35, pan: this.randomThunder() * 1.4 - .7 };
    this.nextThunder = this.automaticThunder ? this.elapsed + 20 + this.randomThunder() * 23 : Infinity;
    return true;
  }

  setFireState(state: FireState, immediate = false): void { this.campfire.setState(state, this.elapsed, immediate); }
  addWood(): boolean { return this.campfire.addWood(this.elapsed); }

  reset(): void {
    this.elapsed = 0; this.gustStarted = -100; this.mode = 'rain';
    this.current = { ...WEATHER_PRESETS.rain }; this.target = { ...WEATHER_PRESETS.rain };
    this.wetness = .88; this.snowCover = 0; this.automaticThunder = false;
    this.nextThunder = Infinity; this.strike = null; this.strikeId = 0;
    this.randomThunder = createRandom(`${this.seed}:thunder-events`);
    this.revision += 1; this.campfire.reset();
  }

  snapshot(delta = 0): EnvironmentSnapshot {
    const age = this.elapsed - this.gustStarted;
    const pulse = age >= 0 && age < 7 ? Math.sin(Math.min(age / 7, 1) * Math.PI) ** 2 : 0;
    const gust = pulse * this.gustStrength;
    const drift = (.45 + Math.sin(this.elapsed * .21 + this.phase) * .16) * (.7 + this.current.storm * 1.4);
    let lightning: LightningSnapshot | null = null;
    if (this.strike) {
      const strikeAge = this.elapsed - this.strike.time;
      const delay = this.strike.distance / 343;
      // One broad flash with a soft tail, never a high-frequency sequence.
      const flash = this.reducedMotion || strikeAge >= .8 ? 0
        : this.strike.intensity * Math.exp(-strikeAge / .17);
      lightning = { id: this.strike.id, age: strikeAge, distance: this.strike.distance,
        delay, intensity: this.strike.intensity, flash, pan: this.strike.pan };
    }
    return {
      elapsed: this.elapsed, delta,
      wind: {
        x: drift + gust * this.gustDirection * 2.2,
        y: .035 + this.current.storm * .12 + gust * .55,
        z: .12 + Math.sin(this.elapsed * .13 + this.phase) * .14,
        strength: Math.min(1, .12 + this.current.storm * .45 + drift * .10 + gust * .65),
      },
      precipitation: this.current.rain,
      weather: { mode: this.mode, ...this.current, wetness: this.wetness, snowCover: this.snowCover,
        automaticThunder: this.automaticThunder, revision: this.revision },
      lightning, fire: this.campfire.snapshot(this.elapsed), gust, reducedMotion: this.reducedMotion,
    };
  }
}
