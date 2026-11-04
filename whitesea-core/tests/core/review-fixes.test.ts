/**
 * Pins for the §5.7 `/code-review high` fixes in core (2026-09-24).
 */
import { describe, expect, it } from 'vitest';
import { advance } from '../../src/core/clock';
import { WORLD_MAX, WORLD_MIN, inWorld } from '../../src/core/hex';
import { stateFromLayout } from '../../src/core/sim';
import { buildableCells } from '../../src/core/territory';
import type { IslandState, Layout } from '../../src/core/types';
import { RES_SCALE } from '../../src/core/types';

const ZERO = { wood: 0, food: 0, stone: 0, iron: 0 };

describe('advance: an overdue active item', () => {
  it('completes at once and time keeps accruing, instead of stalling the loop', () => {
    const layout: Layout = [
      { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 1 },
      { q: 1, r: 0, terrain: 'land', building: null, level: 0 },
    ];
    const base = stateFromLayout(layout, { time: 100_000, treasury: { ...ZERO } }); // empty: nothing clamps at the cap
    // Started at t=0, due at t=50 000 — already 50 s overdue at t=100 000 (a foreign/edited save).
    const state: IslandState = {
      ...base,
      queue: [{ id: 1, kind: 'build', q: 1, r: 0, building: 'forest', level: 1, paid: ZERO, durationMs: 50_000, startedAt: 0 }],
      nextItemId: 2,
    };
    const { state: after, events } = advance(state, 3_600_000);
    expect(after.queue).toHaveLength(0);
    expect(after.tiles['1,0']?.building?.id).toBe('forest');
    expect(events.some((e) => e.kind === 'completed')).toBe(true);
    // The town hall's +5 wood/h still accrued over the hour.
    expect(after.treasury.wood - state.treasury.wood).toBe(5 * RES_SCALE);
    expect(after.time).toBe(state.time + 3_600_000);
  });
});

describe('the world bound is one rule', () => {
  it('inWorld is the MapID window', () => {
    expect(WORLD_MIN).toBe(-26);
    expect(WORLD_MAX).toBe(25);
    expect(inWorld(25, -26)).toBe(true);
    expect(inWorld(26, 0)).toBe(false);
    expect(inWorld(0, -27)).toBe(false);
  });

  it('buildableCells never offers a cell placeTerrain would refuse for the bound', () => {
    // A town hall on the window's east edge: its territory reaches past q = 25.
    const layout: Layout = [{ q: 25, r: 0, terrain: 'land', building: 'mainhouse', level: 4 }];
    for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
      layout.push({ q: 25 + dq, r: dr, terrain: 'land', building: null, level: 0 });
    }
    const inside = layout.filter((c) => inWorld(c.q, c.r));
    const cells = buildableCells(stateFromLayout(inside));
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(inWorld(c.q, c.r)).toBe(true);
  });
});
