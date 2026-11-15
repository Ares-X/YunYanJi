import { describe, expect, it, vi } from 'vitest';
import { AMBIENCE_LOOP_SOURCES, MAX_TRANSIENT_SOURCES, createAmbienceGraph } from '../../src/audio/createAmbienceGraph';
import { WeatherSimulation } from '../../src/core/WeatherSimulation';
import type { EnvironmentSnapshot } from '../../src/core/types';

// PCM quality is tested against real generators in audio-synthesis.test.ts.
// Short deterministic buffers isolate graph ownership and event scheduling here.
vi.mock('../../src/audio/synthesis', () => {
  const loop = () => new Float32Array(2400);
  return { generateEmberLoop: loop, generateFireCrackleLoop: loop, generateRainDropsLoop: loop,
    generateRainLoop: loop, generateSnowLoop: loop, generateWindLoop: loop,
    generateThunder: () => new Float32Array(24000 * 12), generateWoodFeed: () => new Float32Array(43200) };
});

class Parameter {
  value = 0;
  cancelScheduledValues() { return this; }
  setValueAtTime(value: number) { this.value = value; return this; }
  setTargetAtTime(value: number) { this.value = value; return this; }
  linearRampToValueAtTime(value: number) { this.value = value; return this; }
}
class Node {
  disconnected = false;
  connect(target: Node) { return target; }
  disconnect() { this.disconnected = true; }
}
class Source extends Node {
  buffer: { duration: number } | null = null;
  loop = false;
  playbackRate = new Parameter();
  onended: (() => void) | null = null;
  starts: { when: number; offset: number }[] = [];
  stops = 0;
  start(when: number, offset = 0) { this.starts.push({ when, offset }); }
  stop() { this.stops++; }
}
class FakeContext {
  currentTime = 0;
  destination = new Node();
  nodes: Node[] = [];
  sources: Source[] = [];
  own<T extends Node>(node: T) { this.nodes.push(node); return node; }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const samples = new Float32Array(length);
    return { duration: length / sampleRate, getChannelData: () => samples };
  }
  createBufferSource() { const source = this.own(new Source()); this.sources.push(source); return source; }
  createGain() { return this.own(Object.assign(new Node(), { gain: new Parameter() })); }
  createStereoPanner() { return this.own(Object.assign(new Node(), { pan: new Parameter() })); }
  createBiquadFilter() { return this.own(Object.assign(new Node(), { type: 'lowpass', frequency: new Parameter(), Q: new Parameter() })); }
  createDynamicsCompressor() { return this.own(Object.assign(new Node(), { threshold: new Parameter(), knee: new Parameter(),
    ratio: new Parameter(), attack: new Parameter(), release: new Parameter() })); }
}

function sample(elapsed = 0): EnvironmentSnapshot {
  return { ...new WeatherSimulation('graph-test').snapshot(), elapsed };
}
function arrival(id: number, elapsed: number): EnvironmentSnapshot {
  return { ...sample(elapsed), lightning: { id, age: 2.05, delay: 2, distance: 686, intensity: 0.8, pan: -0.4, flash: 0 } };
}

describe('bounded audio graph ownership', () => {
  it('uses simulation arrival, finite polyphony, and releases every event node on end/pause/dispose', () => {
    const context = new FakeContext();
    const graph = createAmbienceGraph(context as unknown as BaseAudioContext, 'graph-test');
    expect(graph.sourceCount).toBe(AMBIENCE_LOOP_SOURCES);
    graph.update(sample());
    graph.setActive(true);
    graph.update({ ...arrival(1, 1), lightning: { ...arrival(1, 1).lightning!, age: 1 } });
    expect(context.sources).toHaveLength(AMBIENCE_LOOP_SOURCES);
    context.currentTime = 4;
    graph.update(arrival(1, 2.05));
    const thunder = context.sources.at(-1)!;
    expect(thunder.starts).toEqual([{ when: 4, offset: expect.closeTo(0.05) }]);
    graph.update(arrival(1, 2.05));
    expect(graph.diagnostics().audioThunders).toBe(1);
    thunder.onended?.();
    expect(thunder.buffer).toBeNull();
    expect(thunder.disconnected).toBe(true);
    expect(graph.sourceCount).toBe(AMBIENCE_LOOP_SOURCES);
    for (let id = 2; id < 15; id++) {
      const frame = arrival(id, id * 3);
      graph.update({ ...frame, fire: { ...frame.fire, feedId: id, feedAge: 0 } });
      expect(graph.sourceCount).toBeLessThanOrEqual(AMBIENCE_LOOP_SOURCES + MAX_TRANSIENT_SOURCES);
    }
    expect(graph.diagnostics().audioTransientSources).toBe(4);
    graph.setActive(false);
    expect(graph.sourceCount).toBe(AMBIENCE_LOOP_SOURCES);
    expect(context.nodes.filter(node => !node.disconnected)).toHaveLength(30);
    graph.dispose();
    graph.dispose();
    expect(graph.sourceCount).toBe(0);
    expect(graph.diagnostics().audioNodes).toBe(0);
    expect(context.nodes.every(node => node.disconnected)).toBe(true);
    expect(context.sources.every(source => source.buffer === null)).toBe(true);
    expect(context.sources.every(source => source.stops <= 1)).toBe(true);
  });

  it('keeps volume zero and late activation from reviving old thunder or feeding', () => {
    const context = new FakeContext();
    const graph = createAmbienceGraph(context as unknown as BaseAudioContext, 'graph-test');
    graph.update(arrival(1, 2.05));
    graph.setActive(true);
    graph.update(arrival(1, 2.05));
    expect(graph.diagnostics().audioThunders).toBe(0);
    graph.setVolume(0);
    graph.update(arrival(2, 6));
    graph.setVolume(0.5);
    graph.update(arrival(2, 6));
    expect(graph.diagnostics().audioThunders).toBe(0);
    graph.update(arrival(3, 9));
    expect(graph.diagnostics().audioThunders).toBe(1);
    graph.update(sample());
    expect(graph.diagnostics().audioTransientSources).toBe(0);
    graph.dispose();
  });
});
