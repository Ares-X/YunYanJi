export const DEFAULT_SEED = 'yunyanji-rainfire-01';

/** Restrict shared seeds to stable, printable text; never insert URL data as HTML. */
export function readSeed(search: string): string {
  const seed = new URLSearchParams(search).get('seed')?.trim();
  return seed && /^[\p{L}\p{N}_-]{1,64}$/u.test(seed) ? seed : DEFAULT_SEED;
}

export function sceneLink(location: string, seed: string): string {
  const url = new URL(location);
  // Share world identity; omit local diagnostics and test flags.
  url.search = '';
  url.searchParams.set('seed', seed);
  url.hash = '';
  return url.href;
}
