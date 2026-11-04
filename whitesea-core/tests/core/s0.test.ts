// Open Sea S0.1–S0.3 (specs/S0.md): timed terrain placement, the 20-piece storage cap, and the
// level scale to TH 20 (VC max 15). DECISIONS 2026-09-25 #2, #5, #7, #11.
import { describe, expect, it } from 'vitest';
import { advance } from '../../src/core/clock';
import { MAX_QUEUE, PIECE_CAP, PLACE_DURATION_MS } from '../../src/core/config';
import { buildersFor, costAt, secondsAt } from '../../src/core/costtime';
import { neighbors } from '../../src/core/hex';
import { storedPieces, truncateGrant } from '../../src/core/pieces';
import { deserialize, serialize } from '../../src/core/save';
import { apply, newIsland, project, stateFromLayout, validate } from '../../src/core/sim';
import { buildableCells, capacity } from '../../src/core/territory';
import { TERRAIN_IDS } from '../../src/core/types';
import { summarizeAway } from '../../src/game/away';
import type { Command, IslandState, Layout, LayoutRecord, SimEvent, TerrainId } from '../../src/core/types';

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

const RICH = { wood: 45_000, food: 45_000, stone: 45_000, iron: 45_000 };

/** A town hall at `level` on the origin plus the full 7-cell seed ring, then `extra` records. */
function island(level: number, extra: LayoutRecord[] = [], pieces = { land: 5, mountain: 5 }): IslandState {
  const layout: Layout = [
    { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level },
    ...neighbors({ q: 0, r: 0 }).map((h) => ({ q: h.q, r: h.r, terrain: 'land' as const, building: null, level: 0 })),
  ];
  for (const rec of extra) {
    const i = layout.findIndex((x) => x.q === rec.q && x.r === rec.r);
    if (i >= 0) layout[i] = rec;
    else layout.push(rec);
  }
  return stateFromLayout(layout, { treasury: RICH, pieces });
}

function place(q: number, r: number, terrain: TerrainId = 'land'): Command {
  return { kind: 'placeTerrain', q, r, terrain };
}

function applyOk(s: IslandState, cmd: Command): IslandState {
  const v = validate(s, cmd);
  expect(v.ok, `${cmd.kind} refused: ${v.ok ? '' : v.reason.code}`).toBe(true);
  return apply(s, cmd, s.time);
}

function reasonOf(s: IslandState, cmd: Command): unknown {
  const v = validate(s, cmd);
  return v.ok ? null : v.reason;
}

function runQueueOut(s: IslandState): { state: IslandState; events: SimEvent[] } {
  let total = 0;
  for (const item of s.queue) total += item.durationMs;
  return advance(s, total);
}

// ─────────────────────────────────────────────────────────────── S0.1

describe('S0.1 — placement is 2 minutes of queued work', () => {
  it('validates, queues with the piece reserved, completes into a bare tile', () => {
    const s0 = island(2);
    const v = validate(s0, place(2, 0, 'mountain'));
    expect(v).toEqual({
      ok: true,
      quote: {
        cost: { wood: 0, food: 0, stone: 0, iron: 0 },
        refund: { wood: 0, food: 0, stone: 0, iron: 0 },
        durationMs: PLACE_DURATION_MS,
        building: null,
        level: 0,
      },
    });

    const s1 = apply(s0, place(2, 0, 'mountain'), s0.time);
    expect(s1.tiles['2,0']).toBeUndefined(); // not instant any more
    expect(s1.pieces).toEqual({ land: 5, mountain: 4 }); // reserved at enqueue
    expect(storedPieces(s1)).toBe(10); // …but still stored
    expect(s1.treasury).toEqual(s0.treasury); // no resource cost
    expect(s1.queue).toEqual([
      {
        id: s0.nextItemId, kind: 'place', q: 2, r: 0, terrain: 'mountain',
        paid: { wood: 0, food: 0, stone: 0, iron: 0 }, durationMs: PLACE_DURATION_MS, startedAt: 0,
      },
    ]);
    expect(s1.nextItemId).toBe(s0.nextItemId + 1);

    const early = advance(s1, PLACE_DURATION_MS - 1);
    expect(early.state.tiles['2,0']).toBeUndefined();
    expect(early.events.filter((e) => e.kind === 'completed')).toEqual([]);

    const { state, events } = advance(early.state, 1);
    expect(state.tiles['2,0']).toEqual({ q: 2, r: 0, terrain: 'mountain', seed: false, building: null });
    expect(state.queue).toEqual([]);
    expect(state.pieces).toEqual({ land: 5, mountain: 4 });
    expect(storedPieces(state)).toBe(9); // consumed
    expect(events).toEqual([{ kind: 'completed', at: PLACE_DURATION_MS, item: s1.queue[0] }]);
  });

  it('the quote is 2 minutes whatever the island size', () => {
    const big = island(10, Array.from({ length: 150 }, (_, i) => ({
      q: 200 + (i % 20), r: Math.floor(i / 20), terrain: 'land' as const, building: null, level: 0,
    })));
    const v = validate(big, place(2, 0));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.quote.durationMs).toBe(PLACE_DURATION_MS);
  });

  it('cancel returns the reserved piece and nothing else; the next item starts at now', () => {
    let s = island(2);
    s = applyOk(s, place(2, 0, 'land'));
    s = applyOk(s, { kind: 'build', q: 1, r: 0, building: 'forest' });
    s = advance(s, 1000).state;
    const placeItem = s.queue[0];
    const v = validate(s, { kind: 'cancel', itemId: placeItem.id });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.quote.refund).toEqual({ wood: 0, food: 0, stone: 0, iron: 0 });
    const after = apply(s, { kind: 'cancel', itemId: placeItem.id }, s.time);
    expect(after.pieces).toEqual({ land: 5, mountain: 5 });
    expect(after.treasury).toEqual(s.treasury);
    expect(after.queue.map((i) => i.kind)).toEqual(['build']);
    expect(after.queue[0].startedAt).toBe(1000);
    expect(after.tiles['2,0']).toBeUndefined();
  });

  it('validates against the projection: a queued place occupies its cell and extends adjacency', () => {
    let s = island(3);
    s = applyOk(s, place(2, 0));
    expect(reasonOf(s, place(2, 0, 'mountain'))).toEqual({ code: 'occupied' });
    // (3,0) touches only the queued (2,0): adjacent in the projection, not in the actual state.
    expect(s.tiles['2,0']).toBeUndefined();
    expect(validate(s, place(3, 0)).ok).toBe(true);
    // A build on the queued cell is legal too (checked below for ordering).
    expect(validate(s, { kind: 'build', q: 2, r: 0, building: 'forest' }).ok).toBe(true);
  });

  it('noPiece counts the reservation; queueFull applies; each reason in the order §S0.1 lists', () => {
    let s = island(3, [], { land: 1, mountain: 3 });
    s = applyOk(s, place(2, 0, 'land'));
    expect(reasonOf(s, place(2, -1, 'land'))).toEqual({ code: 'noPiece', terrain: 'land' });
    s = applyOk(s, place(2, -1, 'mountain'));
    s = applyOk(s, place(-2, 0, 'mountain'));
    s = applyOk(s, place(-2, 1, 'mountain'));
    expect(s.queue.length).toBe(MAX_QUEUE);
    const full = island(3, [], { land: 5, mountain: 5 });
    let q = full;
    for (const c of [[2, 0], [2, -1], [-2, 0], [-2, 1]] as const) q = applyOk(q, place(c[0], c[1]));
    expect(reasonOf(q, place(0, 2))).toEqual({ code: 'queueFull', size: MAX_QUEUE });
    expect(reasonOf(q, place(5, 5))).toEqual({ code: 'notAdjacent' });
    expect(reasonOf(q, place(4, 0))).toEqual({ code: 'notAdjacent' }); // (3,0) is not placed
  });

  it('outsideTerritory and islandFull read the projected island', () => {
    // TH2: radius-2 territory, cap 40. 7 seed + 32 far filler = 39 tiles; one queued place fills it.
    const filler = Array.from({ length: 32 }, (_, i) => ({
      q: 200 + i, r: 0, terrain: 'land' as const, building: null, level: 0,
    }));
    let s = island(2, filler);
    expect(capacity(s.tiles).islandSize).toBe(39);
    expect(reasonOf(s, place(3, 0))).toEqual({ code: 'notAdjacent' });
    s = applyOk(s, place(2, 0));
    expect(reasonOf(s, place(3, 0))).toEqual({ code: 'outsideTerritory' });
    expect(reasonOf(s, place(2, -1))).toEqual({ code: 'islandFull', cap: 40 });
  });

  it('FIFO: a build on a queued-place cell runs after it', () => {
    let s = island(2);
    s = applyOk(s, place(2, 0, 'land'));
    s = applyOk(s, { kind: 'build', q: 2, r: 0, building: 'forest' });
    const [placeItem, buildItem] = s.queue;
    expect(buildItem.startedAt).toBeNull();

    const mid = advance(s, PLACE_DURATION_MS);
    expect(mid.state.tiles['2,0']).toEqual({ q: 2, r: 0, terrain: 'land', seed: false, building: null });
    expect(mid.events).toEqual([
      { kind: 'completed', at: PLACE_DURATION_MS, item: placeItem },
      { kind: 'started', at: PLACE_DURATION_MS, item: { ...buildItem, startedAt: PLACE_DURATION_MS } },
    ]);
    const end = advance(mid.state, buildItem.durationMs);
    expect(end.state.tiles['2,0'].building).toEqual({ id: 'forest', level: 1 });
    // …and the build is priced against the terrain it will land on.
    expect(reasonOf(island(2), { kind: 'build', q: 2, r: 0, building: 'forest' })).toEqual({ code: 'needsTerrain' });
  });

  it('anything that would invalidate a queued place is refused busy', () => {
    // TH3; (2,0) is player terrain; a queued place at (3,0) touches only it.
    const base = island(3, [{ q: 2, r: 0, terrain: 'land', building: null, level: 0 }]);
    expect(validate(base, { kind: 'removeTerrain', q: 2, r: 0 }).ok).toBe(true);
    const s = applyOk(base, place(3, 0, 'mountain'));
    expect(reasonOf(s, { kind: 'removeTerrain', q: 2, r: 0 })).toEqual({ code: 'busy' });

    // Cancelling a place that a later place / a later build depends on.
    let chain = applyOk(island(3), place(2, 0));
    chain = applyOk(chain, place(3, 0));
    expect(reasonOf(chain, { kind: 'cancel', itemId: chain.queue[0].id })).toEqual({ code: 'busy' });
    expect(validate(chain, { kind: 'cancel', itemId: chain.queue[1].id }).ok).toBe(true);
    let onIt = applyOk(island(3), place(2, 0));
    onIt = applyOk(onIt, { kind: 'build', q: 2, r: 0, building: 'forest' });
    expect(reasonOf(onIt, { kind: 'cancel', itemId: onIt.queue[0].id })).toEqual({ code: 'busy' });
  });

  it('removeTerrain stays instant and still returns its piece', () => {
    const s = island(3, [{ q: 2, r: 0, terrain: 'mountain', building: null, level: 0 }]);
    const after = applyOk(s, { kind: 'removeTerrain', q: 2, r: 0 });
    expect(after.tiles['2,0']).toBeUndefined();
    expect(after.queue).toEqual([]);
    expect(after.pieces).toEqual({ land: 5, mountain: 6 });
  });

  it('buildableCells agrees with validate for placement, queued places included', () => {
    const states: IslandState[] = [];
    let s = island(3);
    states.push(s);
    s = applyOk(s, place(2, 0));
    states.push(s);
    s = applyOk(s, place(3, 0, 'mountain'));
    states.push(s);
    states.push(island(3, [], { land: 0, mountain: 1 }));
    states.push(island(3, [], { land: 0, mountain: 0 }));
    let full = island(3);
    for (const c of [[2, 0], [2, -1], [-2, 0], [-2, 1]] as const) full = applyOk(full, place(c[0], c[1]));
    states.push(full);

    for (const st of states) {
      const offered = new Set(buildableCells(st).map((h) => `${h.q},${h.r}`));
      for (let q = -6; q <= 6; q++) {
        for (let r = -6; r <= 6; r++) {
          const ok = TERRAIN_IDS.some((t) => validate(st, place(q, r, t)).ok);
          expect(offered.has(`${q},${r}`), `cell ${q},${r}`).toBe(ok);
        }
      }
    }
    // The queued cell is not offered; the cell only it touches is.
    const offered = buildableCells(states[1]).map((h) => `${h.q},${h.r}`);
    expect(offered).not.toContain('2,0');
    expect(offered).toContain('3,0');
  });
});

// ─────────────────────────────────────────────────────────────── associativity & catch-up

function mixedQueue(): IslandState {
  let s = island(2);
  s = applyOk(s, place(2, 0, 'land'));
  s = applyOk(s, { kind: 'build', q: 1, r: 0, building: 'forest' });
  s = applyOk(s, place(2, -1, 'land'));
  s = applyOk(s, { kind: 'build', q: 2, r: 0, building: 'lumberjack' });
  expect(s.queue.map((i) => i.kind)).toEqual(['place', 'build', 'place', 'build']);
  return s;
}

function checkAssociative(s: IslandState, a: number, b: number): void {
  const direct = advance(s, a + b);
  const step1 = advance(s, a);
  const step2 = advance(step1.state, b);
  expect(step2.state).toEqual(direct.state);
  expect([...step1.events, ...step2.events]).toEqual(direct.events);
}

describe('S0.1 — advance stays associative over queues mixing place and build', () => {
  it('splits on every completion boundary (±1 ms) and at random', () => {
    const s = mixedQueue();
    const total = s.queue.reduce((n, i) => n + i.durationMs, 0) + 3_600_000;
    const cuts: number[] = [];
    let at = 0;
    for (const item of s.queue) {
      at += item.durationMs;
      cuts.push(at - 1, at, at + 1);
    }
    const rng = mulberry32(20260930);
    for (let i = 0; i < 20; i++) cuts.push(Math.floor(rng() * (total + 1)));
    for (const a of cuts) checkAssociative(s, a, total - a);
  });

  it('the whole queue completes in order into the projected layout', () => {
    const s = mixedQueue();
    const { state, events } = runQueueOut(s);
    const completed = events.filter((e) => e.kind === 'completed').map((e) => (e.kind === 'completed' ? e.item.kind : ''));
    expect(completed).toEqual(['place', 'build', 'place', 'build']);
    expect(state.tiles).toEqual(project(s).tiles);
    expect(state.pieces).toEqual(project(s).pieces);
  });

  it('catch-up: one long advance equals the same span in 1 000 random chunks', () => {
    const s = mixedQueue();
    const totalMs = 2 * 24 * 3_600_000;
    const direct = advance(s, totalMs);
    const rng = mulberry32(7);
    const cuts = [0, totalMs];
    for (let i = 0; i < 999; i++) cuts.push(Math.floor(rng() * (totalMs + 1)));
    cuts.sort((x, y) => x - y);
    let cur = s;
    const events: SimEvent[] = [];
    for (let i = 1; i < cuts.length; i++) {
      const r = advance(cur, cuts[i] - cuts[i - 1]);
      cur = r.state;
      events.push(...r.events);
    }
    expect(cur).toEqual(direct.state);
    expect(events).toEqual(direct.events);
  });
});

// ─────────────────────────────────────────────────────────────── S0.2

describe('S0.2 — piece storage capped at 20', () => {
  it('the start grant (10 + 10) fills the cap exactly', () => {
    const s = newIsland();
    expect(s.pieces).toEqual({ land: 10, mountain: 10 });
    expect(storedPieces(s)).toBe(PIECE_CAP);
  });

  it('truncateGrant fills round-robin in TERRAIN_IDS order until grant or room runs out', () => {
    expect(truncateGrant(15, { land: 5, mountain: 3 })).toEqual({
      kept: { land: 3, mountain: 2 },
      lost: { land: 2, mountain: 1 },
    });
    expect(truncateGrant(14, { land: 1, mountain: 9 })).toEqual({
      kept: { land: 1, mountain: 5 },
      lost: { land: 0, mountain: 4 },
    });
    expect(truncateGrant(0, { land: 5, mountain: 3 })).toEqual({
      kept: { land: 5, mountain: 3 },
      lost: { land: 0, mountain: 0 },
    });
    expect(truncateGrant(25, { land: 5, mountain: 3 })).toEqual({
      kept: { land: 0, mountain: 0 },
      lost: { land: 5, mountain: 3 },
    });
  });

  it('a TH grant is truncated; piecesGranted reports what was stored, piecesLost the rest', () => {
    let s: IslandState = { ...newIsland(), pieces: { land: 8, mountain: 7 } }; // 15 stored
    s = applyOk(s, { kind: 'upgrade', q: 0, r: 0 });
    const { state, events } = advance(s, s.queue[0].durationMs);
    const at = s.queue[0].durationMs;
    expect(events.filter((e) => e.kind === 'piecesGranted' || e.kind === 'piecesLost')).toEqual([
      { kind: 'piecesGranted', at, pieces: { land: 3, mountain: 2 }, townHallLevel: 2 },
      { kind: 'piecesLost', at, pieces: { land: 2, mountain: 1 } },
    ]);
    expect(state.pieces).toEqual({ land: 11, mountain: 9 });
    expect(storedPieces(state)).toBe(PIECE_CAP);
  });

  it('no piecesLost event when the grant fits', () => {
    let s: IslandState = { ...newIsland(), pieces: { land: 6, mountain: 6 } }; // 12 + 8 = 20
    s = applyOk(s, { kind: 'upgrade', q: 0, r: 0 });
    const { state, events } = advance(s, s.queue[0].durationMs);
    expect(events.some((e) => e.kind === 'piecesLost')).toBe(false);
    expect(state.pieces).toEqual({ land: 11, mountain: 9 });
  });

  it('reserved pieces count toward the cap, so a later cancel can never overflow it', () => {
    // TH2 so there's room to place; 19 in hand, then one reserved by a place queued BEHIND the
    // town-hall upgrade: at the grant, stored = 18 + 1 reserved = 19 → room for exactly 1.
    const warehouse = { q: -1, r: 0, terrain: 'land' as const, building: 'warehouse' as const, level: 25 };
    let s = island(2, [warehouse], { land: 10, mountain: 9 });
    s = applyOk(s, { kind: 'upgrade', q: 0, r: 0 });
    s = applyOk(s, place(2, 0, 'land'));
    expect(storedPieces(s)).toBe(19);
    const thItem = s.queue[0];
    const { state, events } = advance(s, thItem.durationMs);
    expect(events.filter((e) => e.kind === 'piecesGranted' || e.kind === 'piecesLost')).toEqual([
      { kind: 'piecesGranted', at: thItem.durationMs, pieces: { land: 1, mountain: 0 }, townHallLevel: 3 },
      { kind: 'piecesLost', at: thItem.durationMs, pieces: { land: 4, mountain: 3 } },
    ]);
    expect(storedPieces(state)).toBe(PIECE_CAP);
    // The projection agrees with what advance produced.
    expect(project(s).pieces).toEqual(project(state).pieces);
    // Cancelling the place returns its piece without passing the cap.
    const cancelled = applyOk(state, { kind: 'cancel', itemId: state.queue[0].id });
    expect(cancelled.pieces).toEqual({ land: 11, mountain: 9 }); // 9 + 1 granted + 1 returned
    expect(storedPieces(cancelled)).toBe(PIECE_CAP);
  });

  it('removeTerrain at the cap → piecesFull (reserved pieces included)', () => {
    const bare = { q: 2, r: 0, terrain: 'land' as const, building: null, level: 0 };
    const atCap = island(3, [bare], { land: 10, mountain: 10 });
    expect(reasonOf(atCap, { kind: 'removeTerrain', q: 2, r: 0 })).toEqual({ code: 'piecesFull', cap: PIECE_CAP });

    const reserved = applyOk(island(3, [bare], { land: 10, mountain: 9 }), place(-2, 0, 'mountain'));
    expect(reserved.pieces).toEqual({ land: 10, mountain: 8 });
    expect(validate(island(3, [bare], { land: 10, mountain: 8 }), { kind: 'removeTerrain', q: 2, r: 0 }).ok).toBe(true);
    // 18 in hand + 1 reserved = 19 → still room for one.
    expect(validate(reserved, { kind: 'removeTerrain', q: 2, r: 0 }).ok).toBe(true);
    const r2 = applyOk(reserved, place(-2, 1, 'mountain')); // 17 + 2 = 19
    const r3 = applyOk(r2, { kind: 'removeTerrain', q: 2, r: 0 }); // 18 + 2 = 20
    expect(storedPieces(r3)).toBe(PIECE_CAP);
    expect(reasonOf(r3, { kind: 'removeTerrain', q: 1, r: 0 })).toEqual({ code: 'seedLocked' });
  });

  it('an over-cap save loads unchanged, receives nothing, and cannot remove terrain', () => {
    const base = island(3, [
      { q: 2, r: 0, terrain: 'land', building: null, level: 0 },
      { q: -1, r: 0, terrain: 'land', building: 'warehouse', level: 25 }, // storage for the TH4 price
    ], { land: 25, mountain: 10 });
    const loaded = deserialize(serialize(base, 1234));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const s0 = loaded.value.state;
    expect(s0).toEqual(base);
    expect(s0.pieces).toEqual({ land: 25, mountain: 10 });

    expect(reasonOf(s0, { kind: 'removeTerrain', q: 2, r: 0 })).toEqual({ code: 'piecesFull', cap: PIECE_CAP });
    const s1 = applyOk(s0, { kind: 'upgrade', q: 0, r: 0 });
    const { state, events } = advance(s1, s1.queue[0].durationMs);
    expect(events.filter((e) => e.kind === 'piecesGranted' || e.kind === 'piecesLost')).toEqual([
      { kind: 'piecesGranted', at: s1.queue[0].durationMs, pieces: { land: 0, mountain: 0 }, townHallLevel: 4 },
      { kind: 'piecesLost', at: s1.queue[0].durationMs, pieces: { land: 5, mountain: 3 } },
    ]);
    expect(state.pieces).toEqual({ land: 25, mountain: 10 });
  });

  it('"while you were away" counts placements and lost pieces per terrain', () => {
    const warehouse = { q: -1, r: 0, terrain: 'land' as const, building: 'warehouse' as const, level: 25 };
    let s = island(2, [warehouse], { land: 10, mountain: 9 });
    s = applyOk(s, place(2, 0, 'mountain'));
    s = applyOk(s, { kind: 'upgrade', q: 0, r: 0 });
    s = applyOk(s, place(2, -1, 'land'));
    const { state, events } = runQueueOut(s);
    const away = summarizeAway(s, state, events, 60_000);
    expect(away.placed).toEqual({ land: 1, mountain: 1 });
    // At the grant: 17 in hand + 1 reserved (the waiting land place) = 18 → room 2 of 8.
    expect(away.piecesGranted).toEqual({ land: 1, mountain: 1 });
    expect(away.piecesLost).toEqual({ land: 4, mountain: 2 });
    expect(away.completed).toEqual([{ kind: 'upgrade', building: 'mainhouse', level: 3, q: 0, r: 0 }]);
  });

  it('save round-trips a queue holding a place item (schema v1, additive)', () => {
    const s = mixedQueue();
    const json = serialize(s, 99);
    const back = deserialize(json);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.version).toBe(1);
    expect(back.value.state).toEqual(s);
    expect(back.value.state.queue[0]).toEqual(s.queue[0]);
    expect(runQueueOut(back.value.state)).toEqual(runQueueOut(s));
  });
});

// ─────────────────────────────────────────────────────────────── S0.3

describe('S0.3 — village centre to 15, town hall to 20', () => {
  const vcAt = (vc: number, th: number, warehouses = 1): IslandState =>
    island(th, [
      { q: 1, r: 0, terrain: 'land', building: 'villagecentre', level: vc },
      ...[[-1, 0], [0, 1], [0, -1]].slice(0, warehouses).map(([q, r]) => ({
        q, r, terrain: 'land' as const, building: 'warehouse' as const, level: 25,
      })),
    ]);

  it('VC 15 is reachable on the §3.4 curves; VC 16 is maxLevel', () => {
    const s = vcAt(14, 15);
    const v = validate(s, { kind: 'upgrade', q: 1, r: 0 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.quote.level).toBe(15);
      expect(v.quote.cost).toEqual(costAt('villagecentre', 15));
      expect(v.quote.durationMs).toBe(secondsAt('villagecentre', 15) * 1000);
    }
    const done = runQueueOut(applyOk(s, { kind: 'upgrade', q: 1, r: 0 })).state;
    expect(done.tiles['1,0'].building).toEqual({ id: 'villagecentre', level: 15 });
    expect(reasonOf(done, { kind: 'upgrade', q: 1, r: 0 })).toEqual({ code: 'maxLevel', max: 15 });
  });

  it('TH 20 is reachable with VC 15 (island cap 400); TH 21 is gated', () => {
    expect(reasonOf(vcAt(14, 19, 2), { kind: 'upgrade', q: 0, r: 0 })).toEqual({
      code: 'lockedByBuilding', building: 'villagecentre', level: 15,
    });
    const s = vcAt(15, 19, 2);
    const done = runQueueOut(applyOk(s, { kind: 'upgrade', q: 0, r: 0 })).state;
    expect(done.tiles['0,0'].building).toEqual({ id: 'mainhouse', level: 20 });
    const cap = capacity(done.tiles);
    expect(cap.townHallLevel).toBe(20);
    expect(cap.islandCap).toBe(400);
    expect(reasonOf(done, { kind: 'upgrade', q: 0, r: 0 })).toEqual({
      code: 'lockedByBuilding', building: 'villagecentre', level: 16,
    });
  });
});
