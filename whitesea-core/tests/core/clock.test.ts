// Acceptance 4 (W2.md): clock semantics — storage clamp, a warehouse demolish dropping the
// cap and clamping the treasury down, population growth and its cap, a TH level-up granting
// pieces exactly once, and a hand-checked first hour.
import { describe, expect, it } from 'vitest';
import { advance } from '../../src/core/clock';
import { capacity, storageCap } from '../../src/core/territory';
import { apply, newIsland, stateFromLayout } from '../../src/core/sim';
import { RES_SCALE } from '../../src/core/types';
import type { IslandState, Layout } from '../../src/core/types';

describe('clock semantics (acceptance 4)', () => {
  it('storage clamps at the cap; overflow is lost', () => {
    const layout: Layout = [{ q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 }];
    const s = stateFromLayout(layout, { treasury: { wood: 498, food: 498, stone: 0, iron: 0 } });
    // Unconditional +5 wood / +5 food per hour; 2 hours would overshoot the 500 cap.
    const { state, events } = advance(s, 2 * 3_600_000);
    expect(state.treasury.wood).toBe(500 * RES_SCALE);
    expect(state.treasury.food).toBe(500 * RES_SCALE);
    expect(events.some((e) => e.kind === 'storageFull' && e.resource === 'wood')).toBe(true);
    expect(events.some((e) => e.kind === 'storageFull' && e.resource === 'food')).toBe(true);
    // Only on the transition: advancing further while already at cap emits nothing new.
    const again = advance(state, 3_600_000);
    expect(again.events.some((e) => e.kind === 'storageFull')).toBe(false);
  });

  it('demolishing a warehouse drops the storage cap and clamps the treasury down', () => {
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      { q: 1, r: 0, terrain: 'land', building: 'warehouse', level: 2 },
    ];
    const withWarehouse = stateFromLayout(layout);
    const capBefore = storageCap(withWarehouse.tiles);
    const s = stateFromLayout(layout, {
      treasury: { wood: capBefore, food: capBefore, stone: 0, iron: 0 },
    });

    const applied = apply(s, { kind: 'demolish', q: 1, r: 0 }, s.time);
    const item = applied.queue[0];
    const { state } = advance(applied, item.durationMs);

    const capAfter = storageCap(state.tiles);
    expect(capAfter).toBeLessThan(capBefore);
    expect(state.treasury.wood).toBe(capAfter * RES_SCALE);
    expect(state.treasury.food).toBe(capAfter * RES_SCALE);
  });

  it('population grows at 2 + #houses per hour and clamps at its cap', () => {
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      { q: 1, r: 0, terrain: 'land', building: 'house', level: 1 },
      { q: 1, r: -1, terrain: 'land', building: 'house', level: 1 },
    ];
    const s: IslandState = stateFromLayout(layout);
    expect(s.population).toBe(0);
    const cap = capacity(s.tiles);
    expect(cap.populationPerHour).toBe(4); // 2 + 2 houses

    const oneHour = advance(s, 3_600_000);
    expect(oneHour.state.population).toBe(4 * RES_SCALE);

    const long = advance(oneHour.state, 1000 * 3_600_000);
    expect(long.state.population).toBe(cap.populationCap * RES_SCALE);
    expect(long.events.some((e) => e.kind === 'populationFull')).toBe(true);
  });

  it('a mainhouse level completing grants pieces exactly once, guarded by highWater', () => {
    // Below PIECE_CAP so the whole grant fits (newIsland() starts full — S0.2 truncation is
    // pinned in s0.test.ts).
    let s: IslandState = { ...newIsland(), pieces: { land: 2, mountain: 2 } };
    const before = { ...s.pieces };
    s = apply(s, { kind: 'upgrade', q: 0, r: 0 }, s.time);
    const item = s.queue[0];
    const { state, events } = advance(s, item.durationMs);

    expect(state.highWater.mainhouse).toBe(2);
    const grantEvents = events.filter((e) => e.kind === 'piecesGranted');
    expect(grantEvents).toHaveLength(1);
    if (grantEvents[0].kind === 'piecesGranted') {
      expect(grantEvents[0].pieces).toEqual({ land: 5, mountain: 3 });
      expect(grantEvents[0].townHallLevel).toBe(2);
    }
    expect(state.pieces).toEqual({ land: before.land + 5, mountain: before.mountain + 3 });

    // Advancing further (nothing left to complete) never re-grants.
    const again = advance(state, 10 * 3_600_000);
    expect(again.events.some((e) => e.kind === 'piecesGranted')).toBe(false);
  });

  it('a first hour from newIsland() with a forest + lumberjack matches hand arithmetic', () => {
    let s: IslandState = newIsland();
    s = apply(s, { kind: 'build', q: 1, r: 0, building: 'forest' }, s.time);
    s = advance(s, s.queue[0].durationMs).state;
    s = apply(s, { kind: 'build', q: 1, r: -1, building: 'lumberjack' }, s.time);
    s = advance(s, s.queue[0].durationMs).state;

    // Lumberjack L1: radius 1, baseYield 5, 1 eligible forest neighbour, no boosters → +5 wood.
    // Plus the mainhouse's unconditional +5 wood / +5 food. Food has no producer yet.
    const before = s;
    const { state } = advance(s, 3_600_000);
    expect(state.treasury.wood).toBe(before.treasury.wood + 10 * RES_SCALE);
    expect(state.treasury.food).toBe(before.treasury.food + 5 * RES_SCALE);
  });
});
