// Acceptance 1 & 5 (W2.md): advance(s, a+b) ≡ advance(advance(s,a).state, b) — on state AND on
// the concatenated event list — for seeded-random reachable states and random splits (including
// splits landing exactly on a completion and on a storage cap); and catch-up: one long advance
// equals the same span taken in 1 000 random chunks.
import { describe, expect, it } from 'vitest';
import { advance } from '../../src/core/clock';
import { neighbors, parseKey } from '../../src/core/hex';
import { apply, newIsland, validate } from '../../src/core/sim';
import type { BuildingId, Command, IslandState, SimEvent, TerrainId } from '../../src/core/types';

/** Small deterministic PRNG (mulberry32) — never Math.random (ONESHOT §4 purity). */
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

const BUILDING_CHOICES: BuildingId[] = [
  'forest',
  'lumberjack',
  'wheatfield',
  'farm',
  'quarry',
  'irondeposit',
  'stonemason',
  'oremine',
  'warehouse',
  'house',
  'villagecentre',
  'sawmill',
  'bakery',
];

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** Attempt a random-ish command; most attempts refuse harmlessly (validate gates everything). */
function randomCommand(rng: () => number, s: IslandState): Command {
  const roll = rng();
  const tileKeys = Object.keys(s.tiles);

  if (roll < 0.15 && s.queue.length > 0) {
    return { kind: 'cancel', itemId: pick(rng, s.queue).id };
  }
  if (roll < 0.3) {
    const base = parseKey(pick(rng, tileKeys));
    const dir = pick(rng, neighbors({ q: 0, r: 0 }));
    const terrain: TerrainId = rng() < 0.5 ? 'land' : 'mountain';
    return { kind: 'placeTerrain', q: base.q + dir.q, r: base.r + dir.r, terrain };
  }
  if (roll < 0.4) {
    const nonSeed = tileKeys.filter((k) => !s.tiles[k].seed && !s.tiles[k].building);
    if (nonSeed.length > 0) {
      const { q, r } = parseKey(pick(rng, nonSeed));
      return { kind: 'removeTerrain', q, r };
    }
  }
  if (roll < 0.65) {
    const withBuilding = tileKeys.filter((k) => s.tiles[k].building && s.tiles[k].building!.id !== 'mainhouse');
    if (withBuilding.length > 0) {
      const { q, r } = parseKey(pick(rng, withBuilding));
      return rng() < 0.5 ? { kind: 'upgrade', q, r } : { kind: 'demolish', q, r };
    }
  }
  if (roll < 0.75) {
    return { kind: 'upgrade', q: 0, r: 0 };
  }
  const empty = tileKeys.filter((k) => !s.tiles[k].building);
  if (empty.length > 0) {
    const { q, r } = parseKey(pick(rng, empty));
    return { kind: 'build', q, r, building: pick(rng, BUILDING_CHOICES) };
  }
  return { kind: 'upgrade', q: 0, r: 0 };
}

/** Play a random-ish sequence of legal commands, interleaved with small time advances. */
function randomReachableState(rng: () => number, steps: number): IslandState {
  let s: IslandState = newIsland();
  for (let i = 0; i < steps; i++) {
    const dt = Math.floor(rng() * 3 * 3_600_000);
    s = advance(s, dt).state;
    const cmd = randomCommand(rng, s);
    if (validate(s, cmd).ok) s = apply(s, cmd, s.time);
  }
  return s;
}

function checkAssociative(s: IslandState, a: number, b: number): void {
  const direct = advance(s, a + b);
  const step1 = advance(s, a);
  const step2 = advance(step1.state, b);
  expect(step2.state).toEqual(direct.state);
  expect([...step1.events, ...step2.events]).toEqual(direct.events);
}

describe('advance — associativity (acceptance 1)', () => {
  it('advance(s, a+b) ≡ advance(advance(s,a), b) for many random reachable states and splits', () => {
    const rng = mulberry32(20260924);
    for (let trial = 0; trial < 40; trial++) {
      const s = randomReachableState(mulberry32(1000 + trial), 8 + Math.floor(rng() * 10));
      const total = 1000 + Math.floor(rng() * 6 * 3_600_000);
      const a = Math.floor(rng() * (total + 1));
      const b = total - a;
      checkAssociative(s, a, b);
    }
  });

  it('holds for a split landing exactly on a completion', () => {
    const rng = mulberry32(7);
    for (let trial = 0; trial < 10; trial++) {
      let s: IslandState = newIsland();
      s = apply(s, { kind: 'build', q: 1, r: 0, building: 'forest' }, s.time);
      const item = s.queue[0];
      const a = item.durationMs; // exactly at the completion boundary
      const b = 1 + Math.floor(rng() * 500_000);
      checkAssociative(s, a, b);
    }
  });

  it('holds for a split landing exactly on a storage-full transition', () => {
    const s = newIsland();
    const nearCap: IslandState = { ...s, treasury: { ...s.treasury, wood: 499 * 3_600_000 } };
    const remaining = 500 * 3_600_000 - nearCap.treasury.wood;
    const a = Math.ceil(remaining / 5); // mainhouse's unconditional +5 wood/hour → exact ms to cap
    const b = 54321;
    checkAssociative(nearCap, a, b);
  });

  it('holds for a split landing exactly on a completion that also fills the queue with waiting work', () => {
    const rng = mulberry32(99);
    for (let trial = 0; trial < 10; trial++) {
      let s: IslandState = newIsland();
      const nbrs = neighbors({ q: 0, r: 0 });
      for (let i = 0; i < 3; i++) {
        s = apply(s, { kind: 'build', q: nbrs[i].q, r: nbrs[i].r, building: 'forest' }, s.time);
      }
      const active = s.queue[0];
      const a = active.durationMs;
      const b = 1 + Math.floor(rng() * 3 * 3_600_000);
      checkAssociative(s, a, b);
    }
  });
});

describe('catch-up (acceptance 5)', () => {
  it('a long advance with a full queue equals the same span taken in 1 000 random chunks', () => {
    let s: IslandState = newIsland();
    const nbrs = neighbors({ q: 0, r: 0 });
    for (let i = 0; i < 4; i++) {
      s = apply(s, { kind: 'build', q: nbrs[i].q, r: nbrs[i].r, building: 'forest' }, s.time);
    }

    const totalMs = 3 * 24 * 3_600_000; // 3 game-days
    const direct = advance(s, totalMs);

    const rng = mulberry32(42);
    const cuts = [0, totalMs];
    for (let i = 0; i < 999; i++) cuts.push(Math.floor(rng() * (totalMs + 1)));
    cuts.sort((x, y) => x - y);
    expect(cuts.length).toBe(1001); // exactly 1 000 chunks between consecutive cuts

    let cur = s;
    const events: SimEvent[] = [];
    for (let i = 1; i < cuts.length; i++) {
      const dt = cuts[i] - cuts[i - 1];
      const { state, events: ev } = advance(cur, dt);
      cur = state;
      events.push(...ev);
    }

    expect(cur).toEqual(direct.state);
    expect(events).toEqual(direct.events);
  });
});
