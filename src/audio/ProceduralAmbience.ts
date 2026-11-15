import type { EnvironmentSnapshot } from '../core/types';
import { createAmbienceGraph } from './createAmbienceGraph';
import type { AmbienceGraph } from './createAmbienceGraph';

export type AmbienceState = 'off' | 'playing' | 'suspended' | 'unavailable' | 'disposed';

/**
 * Owns one lazily-created context and one reusable synthesized graph.
 * Call setEnabled(true) directly from a user gesture. Pause/visibility are combined
 * by the caller and passed to setSuspended; they never overwrite the user's choice.
 */
export class ProceduralAmbience {
  private context: AudioContext | null = null;
  private graph: AmbienceGraph | null = null;
  private requestedEnabled = false;
  private suspended = false;
  private disposed = false;
  private lastError: string | null = null;
  private currentVolume = 0.45;
  private latestFrame: EnvironmentSnapshot | null = null;
  private transitions: Promise<void> = Promise.resolve();
  private intentRevision = 0;

  constructor(private readonly seed: string) {}

  get enabled(): boolean { return this.requestedEnabled; }
  get volume(): number { return this.currentVolume; }
  get error(): string | null { return this.lastError; }
  get contextState(): AudioContextState | 'uninitialized' {
    return this.context?.state ?? 'uninitialized';
  }
  get state(): AmbienceState {
    if (this.disposed) return 'disposed';
    if (this.lastError) return 'unavailable';
    if (!this.requestedEnabled) return 'off';
    if (this.suspended || this.context?.state !== 'running') return 'suspended';
    return 'playing';
  }

  setEnabled(enabled: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const revision = ++this.intentRevision;
    this.requestedEnabled = enabled;
    if (enabled) this.lastError = null;
    let unlock: Promise<void> | null = null;

    if (enabled && !this.context) {
      this.lastError = null;
      try {
        if (typeof globalThis.AudioContext !== 'function') {
          throw new Error('This browser does not support Web Audio.');
        }
        const context = new AudioContext({ latencyHint: 'playback' });
        this.context = context;
        // This call stays in the initiating user gesture, before any async queue.
        unlock = context.resume();
        this.graph = createAmbienceGraph(context, `${this.seed}:ambience`);
        this.graph.setVolume(this.currentVolume);
        if (this.latestFrame) this.graph.update(this.latestFrame);
        this.transitions = unlock.catch((error: unknown) => {
          if (!this.disposed && revision === this.intentRevision) {
            this.requestedEnabled = false;
            this.lastError = error instanceof Error ? error.message : 'Unable to start audio.';
            this.graph?.setActive(false);
          }
          throw error;
        });
      } catch (error) {
        this.requestedEnabled = false;
        this.lastError = error instanceof Error ? error.message : 'Unable to start audio.';
        this.graph?.dispose();
        this.graph = null;
        const failedContext = this.context;
        this.context = null;
        void failedContext?.close().catch(() => undefined);
        void unlock?.catch(() => undefined);
        return Promise.reject(error);
      }
    }

    this.graph?.setActive(this.shouldPlay);
    const synchronized = this.synchronize();
    // Preserve a failed initial unlock for the UI rather than swallowing it in the queue.
    return (unlock ? unlock.then(() => synchronized) : synchronized).catch((error: unknown) => {
      if (!this.disposed && revision === this.intentRevision) {
        this.requestedEnabled = false;
        this.lastError = error instanceof Error ? error.message : 'Unable to start audio.';
        this.graph?.setActive(false);
      }
      throw error;
    });
  }

  setVolume(volume: number): void {
    this.currentVolume = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0;
    this.graph?.setVolume(this.currentVolume);
  }

  setSuspended(suspended: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.suspended = suspended;
    this.graph?.setActive(this.shouldPlay);
    return this.synchronize();
  }

  update(frame: EnvironmentSnapshot): void {
    if (this.disposed) return;
    this.latestFrame = frame;
    this.graph?.update(frame);
  }

  dispose(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.requestedEnabled = false;
    this.graph?.dispose();
    this.graph = null;
    const context = this.context;
    // Queued reconciliations check disposed. Closing immediately also releases a
    // context whose resume promise was waiting for browser policy/interruption.
    void this.transitions.catch(() => undefined);
    return context && context.state !== 'closed' ? context.close() : Promise.resolve();
  }

  private get shouldPlay(): boolean {
    return this.requestedEnabled && !this.suspended && !this.disposed;
  }

  private synchronize(): Promise<void> {
    // Every request reads the latest desired state when its turn arrives. Rapid
    // toggles cannot let an earlier resume resurrect audio after a newer mute.
    const operation = this.transitions.catch(() => undefined).then(async () => {
      const context = this.context;
      if (!context || this.disposed || context.state === 'closed') return;
      this.graph?.setActive(this.shouldPlay);
      if (this.shouldPlay && context.state !== 'running') {
        this.lastError = null;
        await context.resume();
        this.graph?.setActive(this.shouldPlay);
      }
      if (!this.shouldPlay && context.state === 'running') {
        await context.suspend();
      }
    });
    this.transitions = operation;
    return operation;
  }
}
