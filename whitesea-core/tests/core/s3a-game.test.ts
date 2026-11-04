// S3a.2 — the game step, the coupling, sea commands (specs/S3a.md §S3a.2, §"Tests").
import { describe, expect, it } from 'vitest';
import { advance } from '../../src/core/clock';
import { PLACE_DURATION_MS, SPAWN_POS, TRAVEL_RADIUS_U } from '../../src/core/config';
import { advanceGame, applySea, newGame, validateSea } from '../../src/core/game';
import { IDENTITY_MODIFIERS } from '../../src/core/modifiers';
import { computeProduction } from '../../src/core/economy';
import { apply } from '../../src/core/sim';
import { MS_PER_HOUR, RES_SCALE, RESOURCES } from '../../src/core/types';
import type { Command, GameState, PlaceItem, SeaCommand } from '../../src/core/types';
import { etaOf, positionAt } from '../../src/core/world/mover';

const HOUR = MS_PER_HOUR;

/** A new game whose town hall is L2 (territory radius 2) so terrain can be placed. */
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
function sea(g: GameState, c: SeaCommand): GameState {
  return applySea(g, c, g.island.time);
}
/** Advance the whole game by `dt` (returns state only). */
function step(g: GameState, dt: number): GameState {
  return advanceGame(g, dt).state;
}
const goEast = (u: number): SeaCommand => ({ kind: 'setCourse', target: { x: u, z: 0 } });

function whole(fixed: number): number {
  return Math.floor(fixed / RES_SCALE);
}

describe('newGame', () => {
  it('a new island, a sea holding at SPAWN_POS, nextId 1', () => {
    const g = newGame();
    expect(g.sea.island.state).toBe('holding');
    expect(g.sea.island.pos).toEqual(SPAWN_POS);
    expect(g.sea.nextId).toBe(1);
    expect(g.sea.worldVersion).toBe(0);
    expect(g.island.time).toBe(0);
  });
});

describe('validateSea / applySea', () => {
  it('setCourse from holding → departed course, quote carries the leg time, zero cost', () => {
    const g = newGame();
    const v = validateSea(g, goEast(72));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.quote.durationMs).toBe(HOUR); // 7 tiles → 72 u/h
    expect(v.quote.cost).toEqual({ wood: 0, food: 0, stone: 0, iron: 0 });
    expect(v.quote.refund).toEqual({ wood: 0, food: 0, stone: 0, iron: 0 });
    expect(v.quote.building).toBeNull();
    expect(v.quote.level).toBe(0);
    const after = sea(g, goEast(72));
    expect(after.sea.island.state).toBe('underway');
    expect(after.sea.island.path).toEqual([{ x: 0, z: 0 }, { x: 72, z: 0 }]);
    expect(etaOf(after.sea.island)).toBe(HOUR);
  });

  it('a target outside the disc is clamped', () => {
    const after = sea(newGame(), goEast(5_000));
    expect(after.sea.island.path[1].x).toBeCloseTo(TRAVEL_RADIUS_U, 9);
  });

  it('alreadyThere: to where the island is, and to the current destination while underway', () => {
    const g = newGame();
    const here = validateSea(g, { kind: 'setCourse', target: { x: 0.2, z: 0 } });
    expect(here.ok).toBe(false);
    if (!here.ok) expect(here.reason.code).toBe('alreadyThere');

    const going = sea(g, goEast(72));
    const same = validateSea(going, goEast(72.3));
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.reason.code).toBe('alreadyThere');
    // …but a real change of course is fine
    expect(validateSea(going, goEast(100)).ok).toBe(true);
  });

  it('a redirect underway starts at positionAt(now) and re-times from there; the queue is untouched', () => {
    let g = sea(newGame(), goEast(72));
    g = step(g, HOUR / 2); // 36 u out
    const before = g.island.queue;
    const redirected = sea(g, { kind: 'setCourse', target: { x: 36, z: 36 } });
    const m = redirected.sea.island;
    expect(m.state).toBe('underway');
    expect(m.path[0].x).toBeCloseTo(36, 9);
    expect(m.path[0].z).toBeCloseTo(0, 9);
    expect(m.departAt).toBe(g.island.time);
    expect(m.legs[0].tEnd - m.legs[0].tStart).toBe(Math.ceil((36 / 72) * HOUR));
    expect(redirected.island.queue).toBe(before);
  });

  it('stop holds at positionAt(now); notUnderway when already holding', () => {
    let g = sea(newGame(), goEast(72));
    g = step(g, HOUR / 4);
    const stopped = sea(g, { kind: 'stop' });
    expect(stopped.sea.island.state).toBe('holding');
    expect(stopped.sea.island.pos.x).toBeCloseTo(18, 9);
    expect(stopped.sea.island.legs).toEqual([]);
    const again = validateSea(stopped, { kind: 'stop' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason.code).toBe('notUnderway');
  });

  it('applySea throws on an invalid command and on a stale clock', () => {
    const g = newGame();
    expect(() => applySea(g, { kind: 'stop' }, 0)).toThrow();
    expect(() => applySea(g, goEast(72), 5)).toThrow();
  });

  it('removing a tile mid-voyage does not re-time the course (speed fixed at departure)', () => {
    let g = sea(newGame(), goEast(72));
    const eta = etaOf(g.sea.island);
    g = { ...g, island: { ...g.island, tiles: Object.fromEntries(Object.entries(g.island.tiles).slice(0, 3)) } };
    g = step(g, HOUR / 2);
    expect(etaOf(g.sea.island)).toBe(eta);
  });
});

describe('advanceGame — arrival and the coupling', () => {
  it('arrives at the path end, emits arrived { at: tEnd, pos } and continues holding', () => {
    const g = sea(newGame(), goEast(72));
    const r = advanceGame(g, 3 * HOUR);
    expect(r.state.sea.island.state).toBe('holding');
    expect(r.state.sea.island.pos).toEqual({ x: 72, z: 0 });
    expect(r.state.island.time).toBe(3 * HOUR);
    const arrived = r.events.filter((e) => e.kind === 'arrived');
    expect(arrived).toEqual([{ kind: 'arrived', at: HOUR, pos: { x: 72, z: 0 } }]);
  });

  it('an arrival exactly on the step boundary happens in that step', () => {
    const r = advanceGame(sea(newGame(), goEast(72)), HOUR);
    expect(r.state.sea.island.state).toBe('holding');
    expect(r.events).toContainEqual({ kind: 'arrived', at: HOUR, pos: { x: 72, z: 0 } });
    expect(positionAt(r.state.sea.island, r.state.island.time)).toEqual({ x: 72, z: 0 });
  });

  it('an overdue arrival (foreign save: island.time already past tEnd) arrives at once', () => {
    const g = sea(newGame(), goEast(72));
    const late: GameState = { ...g, island: { ...g.island, time: 5 * HOUR } };
    const r = advanceGame(late, 0);
    expect(r.state.sea.island.state).toBe('holding');
    expect(r.events.some((e) => e.kind === 'arrived')).toBe(true);
    expect(r.state.island.time).toBe(5 * HOUR);
  });

  it('production is exactly floor(rate · 75 / 100) per hour underway, and full again after arrival', () => {
    const base = newGame();
    const perHour = computeProduction(base.island.tiles).perHour;
    const eff = (r: (typeof RESOURCES)[number]) => Math.floor((perHour[r] * 75) / 100);
    expect(perHour.wood).toBeGreaterThan(0);
    expect(eff('wood')).toBeLessThan(perHour.wood); // the floor bites, so the test is not vacuous

    // Treasury starts at cap (wood/food) — drain it so accrual is visible.
    const drained: GameState = {
      ...base,
      island: { ...base.island, treasury: { wood: 0, food: 0, stone: 0, iron: 0 } },
    };
    // to the travel disc's edge (TRAVEL_RADIUS_U ≥ 90 u at 72 u/h: > 1.25 h) → still underway at 1 h
    const underway = step(sea(drained, goEast(240)), HOUR);
    expect(underway.sea.island.state).toBe('underway');
    for (const r of RESOURCES) expect(underway.island.treasury[r]).toBe(eff(r) * HOUR);

    // Holding: the same span at the full rate.
    const holding = step(drained, 2 * HOUR);
    for (const r of RESOURCES) expect(holding.island.treasury[r]).toBe(perHour[r] * 2 * HOUR);

    // Voyage of exactly 1 h, then 1 h holding: 1 h at 75%, 1 h at 100%.
    const round = step(sea(drained, goEast(72)), 2 * HOUR);
    for (const r of RESOURCES) expect(round.island.treasury[r]).toBe(eff(r) * HOUR + perHour[r] * HOUR);
    expect(whole(round.island.treasury.wood)).toBe(eff('wood') + perHour.wood);
  });

  it('population growth is unchanged underway', () => {
    const g = newGame();
    const held = step(g, 2 * HOUR).island.population;
    const moving = step(sea(g, goEast(240)), 2 * HOUR).island.population;
    expect(moving).toBe(held);
  });

  it('a place started before departure pauses at departure and completes `remaining` ms after arrival', () => {
    let g = cmd(th2Game(), { kind: 'placeTerrain', q: 2, r: 0, terrain: 'land' });
    g = step(g, 30_000); // 30 s of the 120 s placement
    g = sea(g, goEast(72)); // departs → paused at 30 s
    const head = g.island.queue[0] as PlaceItem;
    expect(head.pausedAt).toBe(30_000);
    expect(head.startedAt).toBe(0);

    g = step(g, HOUR); // departed at 30 s, 1 h voyage → arrival at 1 h 30 s
    expect(g.sea.island.state).toBe('holding');
    // resumed: startedAt shifted by the time spent paused (1 h), pausedAt cleared
    const resumed = g.island.queue[0] as PlaceItem;
    expect(resumed.pausedAt).toBeUndefined();
    expect(resumed.startedAt).toBe(HOUR);
    expect(g.island.tiles['2,0']).toBeUndefined();

    const remaining = PLACE_DURATION_MS - 30_000; // 90 s left
    const almost = advanceGame(g, remaining - 1);
    expect(almost.state.island.tiles['2,0']).toBeUndefined();
    const done = advanceGame(g, remaining);
    expect(done.state.island.tiles['2,0']).toMatchObject({ terrain: 'land' });
    expect(done.state.island.queue).toEqual([]);
    expect(done.events.filter((e) => e.kind === 'completed')).toHaveLength(1);
  });

  it('a place never completes underway', () => {
    let g = cmd(th2Game(), { kind: 'placeTerrain', q: 2, r: 0, terrain: 'land' });
    g = sea(g, goEast(240)); // departs with the placement 0 s in (to the disc's edge: > 1.25 h)
    g = step(g, HOUR);
    expect(g.sea.island.state).toBe('underway');
    expect(g.island.tiles['2,0']).toBeUndefined();
    expect(g.island.queue).toHaveLength(1);
  });

  it('a place that starts underway starts paused (behind a build that finishes underway)', () => {
    let g = th2Game();
    g = cmd(g, { kind: 'build', q: 1, r: 0, building: 'forest' }); // field: quick
    g = cmd(g, { kind: 'placeTerrain', q: 2, r: 0, terrain: 'land' }); // waits behind the forest
    const forestMs = g.island.queue[0].durationMs;
    g = sea(g, goEast(240)); // the head (a build) is not paused
    expect((g.island.queue[0] as { pausedAt?: number }).pausedAt).toBeUndefined();

    const r = advanceGame(g, forestMs + 10 * 60_000);
    expect(r.state.sea.island.state).toBe('underway');
    const started = r.events.find((e) => e.kind === 'started' && e.item.kind === 'place');
    expect(started).toBeDefined();
    const head = r.state.island.queue[0] as PlaceItem;
    expect(head.kind).toBe('place');
    expect(head.startedAt).toBe(forestMs);
    expect(head.pausedAt).toBe(forestMs);
    expect(r.state.island.tiles['2,0']).toBeUndefined();
    expect(r.state.island.tiles['1,0'].building).toEqual({ id: 'forest', level: 1 });
  });

  it('a place queued while underway (empty queue) is paused from the first advance', () => {
    let g = sea(th2Game(), goEast(240));
    g = cmd(g, { kind: 'placeTerrain', q: 2, r: 0, terrain: 'land' });
    g = step(g, HOUR);
    expect(g.island.tiles['2,0']).toBeUndefined();
    expect((g.island.queue[0] as PlaceItem).pausedAt).toBe(0);
  });

  it('a build behind a paused place waits (FIFO), then runs after the placement', () => {
    let g = th2Game();
    g = cmd(g, { kind: 'placeTerrain', q: 2, r: 0, terrain: 'land' });
    g = cmd(g, { kind: 'build', q: 2, r: 0, building: 'forest' }); // needs the terrain first
    const forestMs = g.island.queue[1].durationMs;
    g = sea(g, goEast(72)); // pauses the placement at t = 0
    g = step(g, HOUR); // arrives at 1 h
    expect(g.island.queue).toHaveLength(2);
    expect(g.island.queue[1].startedAt).toBeNull(); // the build waited the whole voyage

    const r = advanceGame(g, PLACE_DURATION_MS + forestMs);
    expect(r.state.island.queue).toEqual([]);
    expect(r.state.island.tiles['2,0'].building).toEqual({ id: 'forest', level: 1 });
  });

  it('a build at the head runs normally underway', () => {
    let g = cmd(th2Game(), { kind: 'build', q: 1, r: 0, building: 'forest' });
    const ms = g.island.queue[0].durationMs;
    g = sea(g, goEast(240));
    const r = advanceGame(g, ms);
    expect(r.state.sea.island.state).toBe('underway');
    expect(r.state.island.tiles['1,0'].building).toEqual({ id: 'forest', level: 1 });
  });

  it('stop resumes a paused placement at the stop time', () => {
    let g = cmd(th2Game(), { kind: 'placeTerrain', q: 2, r: 0, terrain: 'land' });
    g = step(g, 20_000);
    g = sea(g, goEast(240));
    g = step(g, 600_000);
    g = sea(g, { kind: 'stop' });
    const head = g.island.queue[0] as PlaceItem;
    expect(head.pausedAt).toBeUndefined();
    expect(head.startedAt).toBe(600_000); // 0 + the 600 s spent paused
    expect(PLACE_DURATION_MS - (g.island.time - head.startedAt!)).toBe(PLACE_DURATION_MS - 20_000); // 100 s remain
  });
});

describe('advanceGame — without a course it is exactly advance', () => {
  it('a holding game equals island advance (state and events)', () => {
    const g = th2Game();
    const a = advanceGame(g, 7 * HOUR + 123);
    const b = advance(g.island, 7 * HOUR + 123);
    expect(a.state.island).toEqual(b.state);
    expect(a.events).toEqual(b.events);
    expect(a.state.sea).toEqual(g.sea);
  });
  it('rejects a negative or fractional dt', () => {
    expect(() => advanceGame(newGame(), -1)).toThrow();
    expect(() => advanceGame(newGame(), 1.5)).toThrow();
  });
});

describe('the clock `cond` parameter', () => {
  it('advance with an identity-holding cond is byte-for-byte the default', () => {
    const s = th2Game().island;
    const a = advance(s, 5 * HOUR + 77);
    const b = advance(s, 5 * HOUR + 77, { underway: false, modifiers: IDENTITY_MODIFIERS });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
