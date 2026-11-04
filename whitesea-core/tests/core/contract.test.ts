// W0 smoke: the contract, catalog and fixture load and agree with each other.
import { describe, expect, it } from 'vitest';
import { ALL_DEFS, CATALOG } from '../../src/core/catalog';
import { distance, fromWorld, toWorld } from '../../src/core/hex';
import { BUILDING_IDS, RES_SCALE } from '../../src/core/types';
import { FIXTURE_MIDGAME } from '../../src/game/fixtures';

describe('W0 contract smoke', () => {
  it('catalog covers the §3.2 roster exactly', () => {
    expect(ALL_DEFS.map((d) => d.id)).toEqual([...BUILDING_IDS]);
    expect(Object.keys(CATALOG)).toHaveLength(16);
  });

  it('fixed-point scale is one hour of milliseconds', () => {
    expect(RES_SCALE).toBe(3_600_000);
  });

  it('fixture honours terrain gates and the TH cap', () => {
    const th = FIXTURE_MIDGAME.find((t) => t.building === 'mainhouse');
    expect(th?.level).toBe(7);
    for (const t of FIXTURE_MIDGAME) {
      if (t.building) {
        expect(CATALOG[t.building].terrain).toBe(t.terrain);
        expect(t.level).toBeLessThanOrEqual(th!.level);
        expect(t.level).toBeGreaterThanOrEqual(1);
      } else {
        expect(t.level).toBe(0);
      }
    }
  });

  it('hex round-trip holds at a few centres', () => {
    for (const h of [{ q: 0, r: 0 }, { q: 3, r: -2 }, { q: -5, r: 4 }]) {
      const w = toWorld(h);
      expect(fromWorld(w.x, w.z)).toEqual(h);
      expect(distance(h, h)).toBe(0);
    }
  });
});
