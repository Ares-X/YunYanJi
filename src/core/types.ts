export type QualityLevel = 'low' | 'medium' | 'high';
export type QualityPreference = 'auto' | QualityLevel;

/** Units: metres, seconds. +Y up; one shared weather sample for every subsystem. */
export interface EnvironmentSnapshot {
  readonly elapsed: number;
  readonly delta: number;
  readonly wind: { readonly x: number; readonly y: number; readonly z: number; readonly strength: number };
  readonly snowIntensity: number;
  readonly gust: number;
  readonly reducedMotion: boolean;
}
