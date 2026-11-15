import { createRainfireWorld } from './rainfire/createRainfireWorld';
import type { LandscapeDefinition } from './types';

export const landscapes: readonly LandscapeDefinition[] = [{
  id: 'rainfire',
  title: '雨歇之前',
  subtitle: '山林 · 雨夜',
  description: '雨落在林间。火还亮着。',
  create: createRainfireWorld,
}];

export function getLandscape(id = 'rainfire'): LandscapeDefinition {
  return landscapes.find((landscape) => landscape.id === id) ?? landscapes[0]!;
}
