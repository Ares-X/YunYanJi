import type { EnvironmentSnapshot } from '../core/types';

export type AmbienceEvent =
  | { readonly kind: 'thunder'; readonly id: number; readonly offset: number; readonly intensity: number; readonly distance: number; readonly pan: number }
  | { readonly kind: 'wood'; readonly id: number; readonly offset: number; readonly hot: boolean };

/**
 * Select one-shots on the simulation clock. Nothing is scheduled ahead on the
 * audio clock: a paused world cannot produce a delayed thunderclap behind a
 * dialog. Events missed while sound was off are consumed, never queued.
 */
export class AmbienceEventCursor {
  private lastElapsed = -Infinity;
  private lastThunder = -1;
  private lastFeed = -1;

  prime(frame: EnvironmentSnapshot): void {
    this.lastElapsed = frame.elapsed;
    this.lastFeed = frame.fire.feedId;
    if (frame.lightning && frame.lightning.age >= frame.lightning.delay) this.lastThunder = frame.lightning.id;
  }

  update(frame: EnvironmentSnapshot, audible: boolean): { reset: boolean; events: readonly AmbienceEvent[] } {
    const reset = frame.elapsed < this.lastElapsed - 1e-6 || frame.fire.feedId < this.lastFeed;
    if (reset) {
      this.lastThunder = -1;
      this.prime(frame);
      return { reset: true, events: [] };
    }
    this.lastElapsed = frame.elapsed;
    const events: AmbienceEvent[] = [];
    const strike = frame.lightning;
    if (strike && strike.id !== this.lastThunder && strike.age >= strike.delay) {
      this.lastThunder = strike.id;
      const offset = strike.age - strike.delay;
      // At most one clamped update can be late. Seeking or enabling later must
      // not resurrect an old impact, even if its synthesized tail is long.
      if (audible && offset <= 0.25) events.push({ kind: 'thunder', id: strike.id, offset,
        intensity: strike.intensity, distance: strike.distance, pan: strike.pan });
    }
    if (frame.fire.feedId !== this.lastFeed) {
      const initialized = this.lastFeed !== -1;
      this.lastFeed = frame.fire.feedId;
      if (initialized && audible && frame.fire.feedId > 0 && frame.fire.feedAge <= 0.25) {
        events.push({ kind: 'wood', id: frame.fire.feedId, offset: Math.max(0, frame.fire.feedAge),
          hot: frame.fire.heat > 0.2 });
      }
    }
    return { reset: false, events };
  }
}
