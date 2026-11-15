import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProceduralAmbience } from '../../src/audio/ProceduralAmbience';
import { createAmbienceGraph } from '../../src/audio/createAmbienceGraph';

vi.mock('../../src/audio/createAmbienceGraph', () => ({
  createAmbienceGraph: vi.fn(() => ({
    sourceCount: 3,
    setActive: vi.fn(),
    setVolume: vi.fn(),
    update: vi.fn(),
    dispose: vi.fn(),
  })),
}));

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static resumeGate: Promise<void> | null = null;
  state: AudioContextState = 'suspended';
  constructor() { FakeAudioContext.instances.push(this); }
  resume = vi.fn(async () => {
    if (FakeAudioContext.resumeGate) await FakeAudioContext.resumeGate;
    if (this.state !== 'closed') this.state = 'running';
  });
  suspend = vi.fn(async () => { this.state = 'suspended'; });
  close = vi.fn(async () => { this.state = 'closed'; });
}

beforeEach(() => {
  FakeAudioContext.instances = [];
  FakeAudioContext.resumeGate = null;
  vi.clearAllMocks();
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('ambience lifecycle', () => {
  it('creates no audio resources until explicitly enabled, then reuses its graph', async () => {
    const ambience = new ProceduralAmbience('winter');
    await ambience.setSuspended(true);
    await ambience.setEnabled(false);
    ambience.setVolume(0.2);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(ambience.state).toBe('off');
    expect(ambience.contextState).toBe('uninitialized');

    await ambience.setSuspended(false);
    const enabling = ambience.setEnabled(true);
    // resume must happen before returning to the caller: the original user gesture.
    expect(FakeAudioContext.instances[0]?.resume).toHaveBeenCalledTimes(1);
    await enabling;
    await ambience.setEnabled(false);
    await ambience.setEnabled(true);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(createAmbienceGraph).toHaveBeenCalledTimes(1);
    expect(ambience.state).toBe('playing');
    expect(ambience.volume).toBe(0.2);
    await ambience.dispose();
  });

  it('keeps the latest mute authoritative while an earlier unlock is still pending', async () => {
    let release: (() => void) | undefined;
    FakeAudioContext.resumeGate = new Promise<void>((resolve) => { release = resolve; });
    const ambience = new ProceduralAmbience('winter');
    const enabling = ambience.setEnabled(true);
    const paused = ambience.setSuspended(true);
    const muted = ambience.setEnabled(false);
    const visibleAgain = ambience.setSuspended(false);
    release?.();
    await Promise.all([enabling, paused, muted, visibleAgain]);
    expect(ambience.enabled).toBe(false);
    expect(ambience.state).toBe('off');
    expect(ambience.contextState).toBe('suspended');
    await ambience.dispose();
  });

  it('suspends for pause/visibility without losing the user sound preference', async () => {
    const ambience = new ProceduralAmbience('winter');
    await ambience.setEnabled(true);
    await ambience.setSuspended(true);
    expect(ambience.enabled).toBe(true);
    expect(ambience.state).toBe('suspended');
    await ambience.setSuspended(false);
    expect(ambience.state).toBe('playing');
    await ambience.dispose();
    await ambience.setEnabled(true);
    await ambience.dispose();
    expect(ambience.state).toBe('disposed');
    expect(FakeAudioContext.instances[0]?.close).toHaveBeenCalledTimes(1);
    expect(createAmbienceGraph).toHaveBeenCalledTimes(1);
  });

  it('reports a blocked initial unlock and permits an explicit retry', async () => {
    FakeAudioContext.resumeGate = Promise.reject(new Error('User gesture required'));
    const ambience = new ProceduralAmbience('winter');
    await expect(ambience.setEnabled(true)).rejects.toThrow('User gesture required');
    expect(ambience.state).toBe('unavailable');
    expect(ambience.enabled).toBe(false);
    FakeAudioContext.resumeGate = null;
    await ambience.setEnabled(true);
    expect(ambience.state).toBe('playing');
    expect(ambience.error).toBeNull();
    await ambience.dispose();
  });
});
