// Acceptance 2 & 3 (W2.md): queue mechanics (FIFO, sizing, quoting, cancel) and verb semantics
// (demolish refund/time, terrain locks, split/strand guards), plus every §4 validation Reason.
import { describe, expect, it } from 'vitest';
import { advance } from '../../src/core/clock';
import { MAX_QUEUE, QUEUE_SIZE } from '../../src/core/config';
import { costAt, demolishMs, demolishRefund } from '../../src/core/costtime';
import { computeProduction } from '../../src/core/economy';
import { neighbors, ring } from '../../src/core/hex';
import { apply, newIsland, stateFromLayout, validate } from '../../src/core/sim';
import { RES_SCALE, RESOURCES } from '../../src/core/types';
import type { IslandState, Layout } from '../../src/core/types';

describe('queue — FIFO, sizing, quoting, cancel (acceptance 2)', () => {
  it('1 active + 3 waiting; a 5th build refuses queueFull', () => {
    let s: IslandState = newIsland();
    const nbrs = neighbors({ q: 0, r: 0 });
    for (let i = 0; i < QUEUE_SIZE + 1; i++) {
      const { q, r } = nbrs[i];
      expect(validate(s, { kind: 'build', q, r, building: 'forest' }).ok).toBe(true);
      s = apply(s, { kind: 'build', q, r, building: 'forest' }, s.time);
    }
    expect(s.queue.length).toBe(MAX_QUEUE);
    expect(s.queue[0].startedAt).toBe(0);
    expect(s.queue.slice(1).every((i) => i.startedAt === null)).toBe(true);

    const fifth = nbrs[QUEUE_SIZE + 1];
    const v = validate(s, { kind: 'build', q: fifth.q, r: fifth.r, building: 'forest' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'queueFull', size: MAX_QUEUE });
  });

  it('several queued upgrade levels on one tile; quote prices the level after the queued ones', () => {
    // TH5 gives headroom (upgrades are capped at the town-hall level) so the queue mechanics,
    // not the TH gate, are what's under test.
    const q = 1;
    const r = 0;
    let s: IslandState = stateFromLayout(
      [
        { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 5 },
        { q, r, terrain: 'land', building: 'lumberjack', level: 1 },
      ],
      { treasury: { wood: 50_000, food: 50_000, stone: 50_000, iron: 50_000 } },
    );

    for (const expectedLevel of [2, 3, 4]) {
      const v = validate(s, { kind: 'upgrade', q, r });
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.quote.level).toBe(expectedLevel);
      s = apply(s, { kind: 'upgrade', q, r }, s.time);
    }
    expect(s.queue.map((i) => (i.kind === 'place' ? 0 : i.level))).toEqual([2, 3, 4]);
  });

  it('cancel refunds 100% of paid and starts the next item at now', () => {
    const s0: IslandState = newIsland();
    const s1 = apply(s0, { kind: 'build', q: 1, r: 0, building: 'forest' }, s0.time);
    const s2 = apply(s1, { kind: 'build', q: 1, r: -1, building: 'forest' }, s1.time);
    const active = s2.queue[0];
    const waiting = s2.queue[1];
    expect(active.startedAt).toBe(0);
    expect(waiting.startedAt).toBeNull();

    const v = validate(s2, { kind: 'cancel', itemId: active.id });
    expect(v.ok).toBe(true);
    const s3 = apply(s2, { kind: 'cancel', itemId: active.id }, s2.time);
    expect(s3.queue.length).toBe(1);
    expect(s3.queue[0].id).toBe(waiting.id);
    expect(s3.queue[0].startedAt).toBe(0);
    // The active item's cost is refunded in full; the waiting item's payment is untouched.
    for (const res of RESOURCES) {
      expect(s3.treasury[res]).toBe(s1.treasury[res]);
    }
  });

  it('cancelling a middle queued upgrade a later one depends on → busy', () => {
    let s: IslandState = stateFromLayout(
      [
        { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 5 },
        { q: 1, r: 0, terrain: 'land', building: 'lumberjack', level: 1 },
      ],
      { treasury: { wood: 50_000, food: 50_000, stone: 50_000, iron: 50_000 } },
    );
    s = apply(s, { kind: 'upgrade', q: 1, r: 0 }, s.time); // -> level 2, active
    s = apply(s, { kind: 'upgrade', q: 1, r: 0 }, s.time); // -> level 3, waiting
    s = apply(s, { kind: 'upgrade', q: 1, r: 0 }, s.time); // -> level 4, waiting
    const middle = s.queue[1];
    const v = validate(s, { kind: 'cancel', itemId: middle.id });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'busy' });
    // The tail item, which nothing depends on, can still be cancelled fine.
    expect(validate(s, { kind: 'cancel', itemId: s.queue[2].id }).ok).toBe(true);
  });

  it('a removeTerrain under queued work → busy', () => {
    const s0 = stateFromLayout([{ q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 2 }]);
    const placing = apply(s0, { kind: 'placeTerrain', q: 1, r: 0, terrain: 'land' }, s0.time);
    const s1 = advance(placing, placing.queue[0].durationMs).state; // S0.1: placement is timed
    const s2 = apply(s1, { kind: 'build', q: 1, r: 0, building: 'forest' }, s1.time);
    const v = validate(s2, { kind: 'removeTerrain', q: 1, r: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'busy' });
  });
});

describe('verbs (acceptance 3)', () => {
  it('demolish refunds floor(50% total invested) incl. upgrades, 75% build time, leaves bare terrain', () => {
    const level = 4;
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      { q: 1, r: 0, terrain: 'land', building: 'lumberjack', level },
    ];
    // Start well below the (warehouse-less, 500) storage cap so neither the mainhouse's
    // unconditional accrual nor the refund gets clamped away, and the effect is visible.
    const s = stateFromLayout(layout, { treasury: { wood: 0, food: 0, stone: 0, iron: 0 } });
    const v = validate(s, { kind: 'demolish', q: 1, r: 0 });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.quote.refund).toEqual(demolishRefund('lumberjack', level));
      expect(v.quote.durationMs).toBe(demolishMs('lumberjack', level));
    }
    const applied = apply(s, { kind: 'demolish', q: 1, r: 0 }, s.time);
    const item = applied.queue[0];
    // The mainhouse's unconditional +5 wood / +5 food accrues over the demolish's own duration
    // too (no eligible fields for the lumberjack itself here, so that's the whole rate).
    const production = computeProduction(s.tiles);
    const { state } = advance(applied, item.durationMs);
    expect(state.tiles['1,0'].building).toBeNull();
    const refund = demolishRefund('lumberjack', level);
    for (const r of RESOURCES) {
      const expected = s.treasury[r] + production.perHour[r] * item.durationMs + refund[r] * RES_SCALE;
      expect(state.treasury[r]).toBe(expected);
    }
  });

  it('the town hall can never be demolished', () => {
    const v = validate(newIsland(), { kind: 'demolish', q: 0, r: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'townHallPermanent' });
  });

  it('seed terrain cannot be removed', () => {
    const v = validate(newIsland(), { kind: 'removeTerrain', q: 1, r: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'seedLocked' });
  });

  it('removing player-placed terrain that would disconnect the island → wouldSplit', () => {
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      { q: 1, r: 0, terrain: 'land', building: null, level: 0 }, // seed (distance 1)
      { q: 2, r: 0, terrain: 'land', building: null, level: 0 }, // bridge
      { q: 3, r: 0, terrain: 'land', building: null, level: 0 }, // depends on the bridge
    ];
    const s = stateFromLayout(layout);
    expect(s.tiles['2,0'].seed).toBe(false);
    const v = validate(s, { kind: 'removeTerrain', q: 2, r: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'wouldSplit' });
  });

  it('interior holes are allowed: removing a non-bridging tile still connects everything', () => {
    const centre = { q: 0, r: 0 };
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      ...neighbors(centre).map((h) => ({ q: h.q, r: h.r, terrain: 'land' as const, building: null, level: 0 })),
      ...ring(centre, 2).map((h) => ({ q: h.q, r: h.r, terrain: 'land' as const, building: null, level: 0 })),
    ];
    // Below PIECE_CAP, so removal may return its piece (S0.2).
    const s = stateFromLayout(layout, { pieces: { land: 5, mountain: 5 } });
    const target = ring(centre, 2)[0];
    const v = validate(s, { kind: 'removeTerrain', q: target.q, r: target.r });
    expect(v.ok).toBe(true);
  });

  it('demolishing a village centre that would strand terrain outside the remaining territory → wouldStrand', () => {
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      { q: 3, r: 0, terrain: 'land', building: 'villagecentre', level: 2 },
      { q: 5, r: 0, terrain: 'land', building: null, level: 0 },
    ];
    const s = stateFromLayout(layout);
    const v = validate(s, { kind: 'demolish', q: 3, r: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'wouldStrand' });
  });

  it('placement: occupied, notAdjacent, outsideTerritory, islandFull, noPiece — each its own reason', () => {
    const s0 = newIsland();

    const occupied = validate(s0, { kind: 'placeTerrain', q: 0, r: 0, terrain: 'land' });
    expect(occupied.ok).toBe(false);
    if (!occupied.ok) expect(occupied.reason).toEqual({ code: 'occupied' });

    const notAdjacent = validate(s0, { kind: 'placeTerrain', q: 20, r: 20, terrain: 'land' });
    expect(notAdjacent.ok).toBe(false);
    if (!notAdjacent.ok) expect(notAdjacent.reason).toEqual({ code: 'notAdjacent' });

    // (2,0) touches the seed neighbour (1,0) but is outside the TH1 radius-1 territory.
    const outside = validate(s0, { kind: 'placeTerrain', q: 2, r: 0, terrain: 'land' });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reason).toEqual({ code: 'outsideTerritory' });

    const noPieceState = stateFromLayout([{ q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 2 }], {
      pieces: { land: 0, mountain: 0 },
    });
    const noPiece = validate(noPieceState, { kind: 'placeTerrain', q: 1, r: 0, terrain: 'land' });
    expect(noPiece.ok).toBe(false);
    if (!noPiece.ok) expect(noPiece.reason).toEqual({ code: 'noPiece', terrain: 'land' });

    // Pad islandSize to the TH1 cap (20) with filler tiles far away, then try to add the one
    // legitimately empty, adjacent, in-territory cell.
    const filler: Layout = Array.from({ length: 19 }, (_, i) => ({
      q: 200 + i,
      r: 0,
      terrain: 'land' as const,
      building: null,
      level: 0,
    }));
    const fullState = stateFromLayout([
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      ...filler,
    ]);
    expect(fullState.tiles['0,0']).toBeDefined();
    const full = validate(fullState, { kind: 'placeTerrain', q: 1, r: 0, terrain: 'land' });
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.reason).toEqual({ code: 'islandFull', cap: 20 });
  });
});

describe('every §4 Reason has a producing test', () => {
  it('lockedByTownHall (build)', () => {
    const v = validate(newIsland(), { kind: 'build', q: 1, r: 0, building: 'warehouse' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'lockedByTownHall', need: 2 });
  });

  it('lockedByBuilding (build, booster high-water gate)', () => {
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 10 },
      { q: 1, r: 0, terrain: 'land', building: 'lumberjack', level: 2 },
      { q: 1, r: -1, terrain: 'land', building: null, level: 0 },
    ];
    const s = stateFromLayout(layout);
    const v = validate(s, { kind: 'build', q: 1, r: -1, building: 'sawmill' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'lockedByBuilding', building: 'lumberjack', level: 3 });
  });

  it('wrongTerrain (build)', () => {
    const v = validate(newIsland(), { kind: 'build', q: 1, r: 0, building: 'quarry' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'wrongTerrain', need: 'mountain' });
  });

  it('needsTerrain (build/upgrade/demolish)', () => {
    for (const cmd of [
      { kind: 'build' as const, q: 50, r: 50, building: 'forest' as const },
      { kind: 'upgrade' as const, q: 50, r: 50 },
      { kind: 'demolish' as const, q: 50, r: 50 },
    ]) {
      const v = validate(newIsland(), cmd);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toEqual({ code: 'needsTerrain' });
    }
  });

  it('occupied (build)', () => {
    const v = validate(newIsland(), { kind: 'build', q: 0, r: 0, building: 'forest' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'occupied' });
  });

  it('noBuilding (upgrade/demolish)', () => {
    for (const cmd of [
      { kind: 'upgrade' as const, q: 1, r: 0 },
      { kind: 'demolish' as const, q: 1, r: 0 },
    ]) {
      const v = validate(newIsland(), cmd);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toEqual({ code: 'noBuilding' });
    }
  });

  it('unaffordable (build), shortfall = the exact cost against a zero treasury', () => {
    const s = stateFromLayout(
      [
        { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
        { q: 1, r: 0, terrain: 'land', building: null, level: 0 },
      ],
      { treasury: { wood: 0, food: 0, stone: 0, iron: 0 } },
    );
    const v = validate(s, { kind: 'build', q: 1, r: 0, building: 'forest' });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'unaffordable', shortfall: costAt('forest', 1) });
  });

  it('exceedsStorage (upgrade): a cost bigger than the (warehouse-less) storage cap', () => {
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 12 },
      { q: 2, r: -2, terrain: 'mountain', building: 'oremine', level: 7 },
      { q: 3, r: -3, terrain: 'mountain', building: 'ironsmelter', level: 9 },
    ];
    const s = stateFromLayout(layout);
    const v = validate(s, { kind: 'upgrade', q: 3, r: -3 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.code).toBe('exceedsStorage');
  });

  it('maxLevel (upgrade a maxLevel-1 field)', () => {
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      { q: 1, r: 0, terrain: 'land', building: 'forest', level: 1 },
    ];
    const v = validate(stateFromLayout(layout), { kind: 'upgrade', q: 1, r: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toEqual({ code: 'maxLevel', max: 1 });
  });

  it('queueFull (upgrade/demolish): a full queue refuses a 5th timed command of any kind', () => {
    let s: IslandState = newIsland();
    const nbrs = neighbors({ q: 0, r: 0 });
    for (let i = 0; i < QUEUE_SIZE + 1; i++) {
      const { q, r } = nbrs[i];
      s = apply(s, { kind: 'build', q, r, building: 'forest' }, s.time);
    }
    expect(s.queue.length).toBe(MAX_QUEUE);
    const upgrade = validate(s, { kind: 'upgrade', q: 0, r: 0 });
    expect(upgrade.ok).toBe(false);
    if (!upgrade.ok) expect(upgrade.reason).toEqual({ code: 'queueFull', size: MAX_QUEUE });

    // Same guard for demolish: a state with an already-completed building and a full queue.
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      { q: 1, r: 0, terrain: 'land', building: 'forest', level: 1 },
    ];
    const s2 = stateFromLayout(layout);
    const fullQueue = s.queue.map((item, i) => ({ ...item, q: 1, r: 0, id: i })); // reuse as filler
    const s3: IslandState = { ...s2, queue: fullQueue };
    const demolish = validate(s3, { kind: 'demolish', q: 1, r: 0 });
    expect(demolish.ok).toBe(false);
    if (!demolish.ok) expect(demolish.reason).toEqual({ code: 'queueFull', size: MAX_QUEUE });
  });
});
