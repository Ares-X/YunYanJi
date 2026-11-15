export type QualityLevel = 'low' | 'medium' | 'high';
export type QualityPreference = 'auto' | QualityLevel;

export type WeatherMode = 'clear' | 'overcast' | 'drizzle' | 'rain' | 'downpour' | 'snow';
export type FireState = 'out' | 'embers' | 'small' | 'steady' | 'roaring';

/** All strengths are normalised. A preset changes targets; the world eases into them. */
export interface WeatherSnapshot {
  readonly mode: WeatherMode;
  readonly rain: number;
  readonly snow: number;
  readonly cloudCover: number;
  readonly daylight: number;
  readonly storm: number;
  readonly wetness: number;
  readonly snowCover: number;
  readonly automaticThunder: boolean;
  readonly revision: number;
}

/** One distant strike. Audio arrives after delay seconds of shared simulation time. */
export interface LightningSnapshot {
  readonly id: number;
  readonly age: number;
  readonly distance: number;
  readonly delay: number;
  readonly intensity: number;
  readonly flash: number;
  readonly pan: number;
}

/** Fuel is finite; a feed adds a visible log and briefly disturbs combustion. */
export interface FireSnapshot {
  readonly state: FireState;
  readonly fuel: number;
  readonly heat: number;
  readonly flame: number;
  readonly embers: number;
  readonly smoke: number;
  readonly addedLogs: number;
  readonly feedId: number;
  readonly feedAge: number;
  readonly revision: number;
}

/** Units: metres, seconds. +Y up; one shared weather sample for every subsystem. */
export interface EnvironmentSnapshot {
  readonly elapsed: number;
  readonly delta: number;
  readonly wind: { readonly x: number; readonly y: number; readonly z: number; readonly strength: number };
  readonly precipitation: number;
  readonly weather: WeatherSnapshot;
  readonly lightning: LightningSnapshot | null;
  readonly fire: FireSnapshot;
  readonly gust: number;
  readonly reducedMotion: boolean;
}
