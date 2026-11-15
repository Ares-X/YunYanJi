import type { FireSnapshot, FireState } from './types';

const FLAME: Record<FireState, number> = { out: 0, embers: 0, small: .27, steady: .62, roaring: .98 };
const EMBERS: Record<FireState, number> = { out: 0, embers: .58, small: .52, steady: .78, roaring: 1 };
const HEAT: Record<FireState, number> = { out: 0, embers: .23, small: .40, steady: .70, roaring: 1 };
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Fuel, heat and tending are independent of both rendering and the audio clock. */
export class CampfireSimulation {
  private state: FireState = 'steady';
  private fuel = .66;
  private flame = FLAME.steady;
  private heat = HEAT.steady;
  private embers = EMBERS.steady;
  private addedLogs = 0;
  private feedId = 0;
  private feedTime = -1000;
  private revision = 0;
  private extinguishedAt = -1000;

  advance(delta: number, elapsed: number): void {
    // A quiet hearth lasts tens of minutes; feeding is an invitation, never a task.
    if (this.state !== 'out') this.fuel = Math.max(0,
      this.fuel - delta * (this.state === 'embers' ? .000025 : .00008 + FLAME[this.state] * .00024));
    if (this.fuel === 0 && this.state !== 'out') {
      this.state = 'out'; this.extinguishedAt = elapsed; this.revision += 1;
    }
    const fuelResponse = Math.min(1, this.fuel / .18);
    const approach = 1 - Math.exp(-delta / 1.35);
    this.flame += (FLAME[this.state] * fuelResponse - this.flame) * approach;
    this.heat += (HEAT[this.state] * fuelResponse - this.heat) * approach;
    this.embers += (EMBERS[this.state] * fuelResponse - this.embers) * approach;
  }

  setState(state: FireState, elapsed: number, immediate = false): void {
    if (!(state in FLAME)) return;
    this.state = state; this.revision += 1;
    if (state === 'out') this.extinguishedAt = elapsed;
    // Choosing a burning state rekindles the wood already in the hearth.
    if (state !== 'out' && this.fuel < .12) this.fuel = .12;
    if (immediate || state === 'out' || state === 'embers') {
      this.flame = FLAME[state]; this.heat = HEAT[state]; this.embers = EMBERS[state];
    }
  }

  addWood(elapsed: number): boolean {
    // Bound both fuel and visible geometry; a cold log does not ignite itself.
    if (this.fuel >= .98 && this.addedLogs >= 4) return false;
    this.fuel = clamp(this.fuel + .18);
    this.addedLogs = Math.min(4, this.addedLogs + 1);
    this.feedTime = elapsed; this.feedId += 1; this.revision += 1;
    if (this.state === 'embers') this.state = 'small';
    return true;
  }

  reset(): void {
    this.state = 'steady'; this.fuel = .66;
    this.flame = FLAME.steady; this.heat = HEAT.steady; this.embers = EMBERS.steady;
    this.addedLogs = 0; this.feedId = 0; this.feedTime = -1000; this.extinguishedAt = -1000;
    this.revision += 1;
  }

  snapshot(elapsed: number): FireSnapshot {
    const feedAge = Math.max(0, elapsed - this.feedTime);
    const catching = feedAge < 24 ? (1 - Math.exp(-feedAge * .65)) * Math.exp(-feedAge / 9) : 0;
    const smoulder = feedAge < 16 ? Math.exp(-feedAge / 4) : 0;
    const burning = this.state !== 'out' && this.state !== 'embers';
    const flame = burning ? clamp(this.flame + catching * .22) : 0;
    const heat = this.state === 'out' ? 0 : clamp(this.heat + catching * .1);
    const embers = this.state === 'out' ? 0 : this.embers;
    const smoke = this.state === 'out'
      ? .16 * Math.exp(-Math.max(0, elapsed - this.extinguishedAt) / 5)
      : clamp(.08 + flame * .24 + smoulder * .3);
    return { state: this.state, fuel: this.fuel, heat, flame, embers, smoke,
      addedLogs: this.addedLogs, feedId: this.feedId, feedAge, revision: this.revision };
  }
}
