// S3a.2 acceptance: advanceGame(s, a+b) ≡ advanceGame(advanceGame(s, a).state, b) — state AND the
// concatenated event list — over whole voyages that cross an arrival with a paused `place` (and
// a waiting build) in the queue; and a 30-h voyage offline ≡ the same span in 1-h steps.
import { describe, expect, it } from 'vitest';
import { advanceGame, applySea, newGame } from '../../src/core/game';
import { apply } from '../../src/core/sim';
import { MS_PER_HOUR } from '../../src/core/types';
import type { Command, GameEvent, GameState } from '../../src/core/types';
import { etaOf } from '../../src/core/world/mover';

const HOUR = MS_PER_HOUR;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function th2Game(): GameState {
  const g = newGame();
  const centre = g.island.tiles['0,0'];
  return {
    ...g,
    island: {
      ...g.island,
      tiles: { ...g.island.tiles, '0,0': { ...centre, building: { id: 'mainhouse', level: 2 } } },
      highWater: { mainhouse: 2 },
    },
  };
}

function cmd(g: GameState, c: Command): GameState {
  return { ...g, island: apply(g.island, c, g.island.time) };
}

/** Run `total` ms in the given cut points; returns the final state and every event, in order. */
function runSplit(start: GameState, total: number, cuts: number[]): { state: GameState; events: GameEvent[] } {
  let state = start;
  const events: GameEvent[] = [];
  let done = 0;
  for (const c of [...cuts, total]) {
    const r = advanceGame(state, c - done);
    state = r.state;
    events.push(...r.events);
    done = c;
  }
  return { state, events };
}

/** A voyage in flight: a placement partly done, a build waiting behind it, then a course. */
function voyage(rng: () => number): { game: GameState; eta: number; departAt: number } {
  let g = th2Game();
  g = cmd(g, { kind: 'placeTerrain', q: 2, r: 0, terrain: 'land' });
  g = cmd(g, { kind: 'build', q: 2, r: 0, building: 'forest' });
  if (rng() < 0.5) g = cmd(g, { kind: 'build', q: 1, r: 0, building: 'forest' });
  g = advanceGame(g, Math.floor(rng() * 90_000)).state; // part of the placement done before leaving
  const angle = rng() * Math.PI * 2;
  const reach = 20 + rng() * 220;
  g = applySea(g, { kind: 'setCourse', target: { x: Math.cos(angle) * reach, z: Math.sin(angle) * reach } }, g.island.time);
  return { game: g, eta: etaOf(g.sea.island)!, departAt: g.island.time };
}

describe('advanceGame associativity', () => {
  it('two-way split over a voyage that crosses an arrival with a paused place queued (200 seeds)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed);
      const { game, eta } = voyage(rng);
      const total = eta - game.island.time + Math.floor(rng() * 3 * HOUR) + 1; // always crosses the arrival
      const cut = Math.floor(rng() * (total + 1));
      const whole = runSplit(game, total, []);
      const split = runSplit(game, total, [cut]);
      expect(split.state, `seed ${seed} cut ${cut}`).toEqual(whole.state);
      expect(split.events, `seed ${seed} cut ${cut}`).toEqual(whole.events);
      // the scenario is not vacuous: the voyage really arrived
      expect(whole.events.some((e) => e.kind === 'arrived')).toBe(true);
    }
  });

  it('many random cuts, including one exactly on the arrival and one just either side (100 seeds)', () => {
    for (let seed = 1000; seed < 1100; seed++) {
      const rng = mulberry32(seed);
      const { game, eta } = voyage(rng);
      const total = eta - game.island.time + Math.floor(rng() * 2 * HOUR) + 2;
      const arrival = eta - game.island.time;
      const cuts = new Set<number>([arrival, arrival - 1, arrival + 1]);
      for (let i = 0; i < 6; i++) cuts.add(Math.floor(rng() * total));
      const sorted = [...cuts].filter((c) => c >= 0 && c <= total).sort((a, b) => a - b);
      const whole = runSplit(game, total, []);
      const split = runSplit(game, total, sorted);
      expect(split.state, `seed ${seed}`).toEqual(whole.state);
      expect(split.events, `seed ${seed}`).toEqual(whole.events);
    }
  });

  it('a split landing before departure of the paused head is irrelevant: cuts inside the voyage too', () => {
    const rng = mulberry32(7);
    const { game, eta } = voyage(rng);
    const total = eta - game.island.time + 4 * HOUR;
    const cuts = Array.from({ length: 40 }, (_, i) => Math.floor(((i + 1) * total) / 41));
    const whole = runSplit(game, total, []);
    const split = runSplit(game, total, cuts);
    expect(split.state).toEqual(whole.state);
    expect(split.events).toEqual(whole.events);
    // and the queue drained after the arrival: the placement and the builds all completed
    expect(whole.state.island.queue).toEqual([]);
  });

  it('a 30-h voyage offline ≡ the same span in 1-h steps', () => {
    const { game } = voyage(mulberry32(42));
    const offline = runSplit(game, 30 * HOUR, []);
    const cuts = Array.from({ length: 29 }, (_, i) => (i + 1) * HOUR);
    const hourly = runSplit(game, 30 * HOUR, cuts);
    expect(hourly.state).toEqual(offline.state);
    expect(hourly.events).toEqual(offline.events);
    expect(offline.state.sea.island.state).toBe('holding');
    expect(offline.events.filter((e) => e.kind === 'arrived')).toHaveLength(1);
  });
});
