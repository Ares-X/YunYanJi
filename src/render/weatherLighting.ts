import type { WeatherSnapshot } from '../core/types';

/** Bounded lighting controls shared by the PBR world, cloud sky and lit mist. */
export function weatherLighting(weather: WeatherSnapshot, flash = 0) {
  const daylight = Math.max(0, Math.min(1, weather.daylight));
  const cloud = Math.max(0, Math.min(1, weather.cloudCover));
  const storm = Math.max(0, Math.min(1, weather.storm));
  const snow = Math.max(0, Math.min(1, weather.snow));
  const rain = Math.max(0, Math.min(1, weather.rain));
  const lightning = Math.max(0, Math.min(1, flash));
  const clearing = daylight * (1 - cloud);
  return {
    clearing,
    sun: (.55 + daylight + 3.8 * daylight * (1 - cloud) ** 3) * (1 - storm * .63) + lightning * 5.5,
    environment: Math.max(.45, 1.2 + daylight * 1.4 - storm * .55 + snow * .10) + lightning * 1.8,
    hemisphere: .07 + daylight * .14 + snow * .04 + lightning * .45,
    fog: .0018 + rain * .0018 + storm * .0035 + snow * .0017,
    // Sun breaks should reveal the forest rather than turn it into white fog.
    // Retain a little moisture near the floor after rain, with dense overcast
    // and storm air unchanged.
    mist: (.24 + cloud * .70 + rain * .25 + storm * .60 + snow * .38) * (1 - clearing * .76),
    // Dense clouds bleach the horizon; fair weather retains a warmer clear gap.
    horizonBrightness: .80 + daylight * .45 - storm * .30 + snow * .12,
  };
}
