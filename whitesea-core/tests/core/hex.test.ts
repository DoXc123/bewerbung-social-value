// Acceptance 6 (W1.md): hex.ts is W0-authored and read-only, but this task owns its tests.
// toWorld/fromWorld round-trip over a radius-12 field incl. points jittered 0.48 toward each
// vertex (0 bad); spiral(c, r).length = 1 + 3r(r+1); direction order pinned.
import { describe, expect, it } from 'vitest';
import { corners, fromWorld, HEX_DIRS, spiral, toWorld } from '../../src/core/hex';

describe('toWorld/fromWorld round-trip', () => {
  it('holds exactly at every hex centre in a radius-12 field', () => {
    for (const h of spiral({ q: 0, r: 0 }, 12)) {
      const w = toWorld(h);
      expect(fromWorld(w.x, w.z)).toEqual(h);
    }
  });

  it('holds for points jittered 0.48 of the way toward each vertex (0 bad)', () => {
    const cs = corners();
    let bad = 0;
    for (const h of spiral({ q: 0, r: 0 }, 12)) {
      const centre = toWorld(h);
      for (const c of cs) {
        const x = centre.x + 0.48 * c.x;
        const z = centre.z + 0.48 * c.z;
        const back = fromWorld(x, z);
        if (back.q !== h.q || back.r !== h.r) bad++;
      }
    }
    expect(bad).toBe(0);
  });
});

describe('spiral cell count', () => {
  it('spiral(c, r).length = 1 + 3r(r+1)', () => {
    for (let r = 0; r <= 12; r++) {
      expect(spiral({ q: 0, r: 0 }, r).length).toBe(1 + 3 * r * (r + 1));
    }
  });
});

describe('direction order', () => {
  it('is pinned to (1,0) (1,-1) (0,-1) (-1,0) (-1,1) (0,1)', () => {
    expect(HEX_DIRS).toEqual([
      { q: 1, r: 0 },
      { q: 1, r: -1 },
      { q: 0, r: -1 },
      { q: -1, r: 0 },
      { q: -1, r: 1 },
      { q: 0, r: 1 },
    ]);
  });
});
