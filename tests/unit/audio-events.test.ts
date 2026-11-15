import { describe, expect, it } from 'vitest';
import { AmbienceEventCursor } from '../../src/audio/audioEvents';
import type { EnvironmentSnapshot } from '../../src/core/types';
import { WeatherSimulation } from '../../src/core/WeatherSimulation';

function frame(elapsed: number, id = 1, age = elapsed): EnvironmentSnapshot {
  return { ...new WeatherSimulation('sound-events').snapshot(), elapsed,
    lightning: { id, age, distance: 686, delay: 2, intensity: 0.8, flash: 0, pan: -0.4 } };
}

describe('simulation-timed sound events', () => {
  it('waits for sound propagation and consumes one thunder arrival exactly once', () => {
    const cursor = new AmbienceEventCursor();
    cursor.prime(frame(0));
    for (const elapsed of [0, 0.9, 1.99, 1.99]) expect(cursor.update(frame(elapsed), true).events).toEqual([]);
    expect(cursor.update(frame(2.04), true).events).toEqual([
      { kind: 'thunder', id: 1, offset: expect.closeTo(0.04), intensity: 0.8, distance: 686, pan: -0.4 },
    ]);
    expect(cursor.update(frame(2.04), true).events).toEqual([]);
    expect(cursor.update(frame(8), true).events).toEqual([]);
  });

  it('does not replay arrivals missed while muted, enabled late, or after a time jump', () => {
    const cursor = new AmbienceEventCursor();
    cursor.prime(frame(0));
    expect(cursor.update(frame(2.05), false).events).toEqual([]);
    expect(cursor.update(frame(2.05), true).events).toEqual([]);
    cursor.prime(frame(9, 2, 4));
    expect(cursor.update(frame(9, 2, 4), true).events).toEqual([]);
    expect(cursor.update(frame(20, 3, 8), true).events).toEqual([]);
    expect(cursor.update(frame(25, 4, 0), true).events).toEqual([]);
    expect(cursor.update(frame(27, 4, 2), true).events).toHaveLength(1);
  });

  it('emits bounded fresh feed intents and treats reset as a cancellation, not a new log', () => {
    const cursor = new AmbienceEventCursor();
    const original = { ...frame(0), lightning: null };
    cursor.prime(original);
    const fed = { ...original, fire: { ...original.fire, feedId: 1, feedAge: 0 } };
    expect(cursor.update(fed, true).events).toEqual([{ kind: 'wood', id: 1, offset: 0, hot: true }]);
    expect(cursor.update(fed, true).events).toEqual([]);
    const missed = { ...fed, elapsed: 2, fire: { ...fed.fire, feedId: 2, feedAge: 0 } };
    expect(cursor.update(missed, false).events).toEqual([]);
    expect(cursor.update(missed, true).events).toEqual([]);
    expect(cursor.update(original, true)).toEqual({ reset: true, events: [] });
    expect(cursor.update(fed, true).events).toHaveLength(1);
  });
});
