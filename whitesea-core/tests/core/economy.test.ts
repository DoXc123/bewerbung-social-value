// Acceptance 3 (W1.md): economy semantics beyond the pinned numbers — non-exclusive fields,
// boosters projecting by their own reach regardless of the producer's, `scanned = 1+3r(r+1)`,
// and worked-set ordering (nearest-first, ties by (q, r)).
import { describe, expect, it } from 'vitest';
import { getDef } from '../../src/core/catalog';
import { baseYield, boostedYield, computeProduction } from '../../src/core/economy';
import { cellsWithin, hexKey } from '../../src/core/hex';
import type { BuildingId, HexKey, Tile } from '../../src/core/types';

function mkTiles(records: Array<[number, number, BuildingId, number?]>): Record<HexKey, Tile> {
  const tiles: Record<HexKey, Tile> = {};
  for (const [q, r, building, level] of records) {
    tiles[hexKey(q, r)] = {
      q,
      r,
      terrain: getDef(building).terrain,
      seed: false,
      building: { id: building, level: level ?? 1 },
    };
  }
  return tiles;
}

describe('non-exclusive fields', () => {
  it('two producers both count the same shared field as eligible and worked', () => {
    // forest at (1,0); lumberjacks at (0,0) and (2,0), both distance 1 from the forest.
    const tiles = mkTiles([
      [1, 0, 'forest'],
      [0, 0, 'lumberjack', 1],
      [2, 0, 'lumberjack', 1],
    ]);
    const report = computeProduction(tiles);
    const a = report.producers[hexKey(0, 0)];
    const b = report.producers[hexKey(2, 0)];
    expect(a.eligible).toBe(1);
    expect(b.eligible).toBe(1);
    expect(a.worked).toBe(1);
    expect(b.worked).toBe(1);

    const forestKey = hexKey(1, 0);
    expect(report.contributions[forestKey].feeds.sort()).toEqual(
      [hexKey(0, 0), hexKey(2, 0)].sort(),
    );
    expect(report.contributions[forestKey].workedBy.sort()).toEqual(
      [hexKey(0, 0), hexKey(2, 0)].sort(),
    );
  });
});

describe('boosters project by their own reach, not the producer\'s', () => {
  it('an L1 lumberjack (1-ring reach) is boosted by an L19 sawmill 3 rings away', () => {
    const tiles = mkTiles([
      [0, 0, 'lumberjack', 1],
      [3, 0, 'sawmill', 19], // distance 3 from the lumberjack; sawmill's own reach at L19 is 3
    ]);
    const report = computeProduction(tiles);
    const jack = report.producers[hexKey(0, 0)];
    expect(jack.boostPct).toBe(19 * 5);
    expect(jack.yieldPerField).toBe(boostedYield(baseYield(1), 95));
    expect(jack.boosters).toEqual([
      { q: 3, r: 0, building: 'sawmill', level: 19, pct: 95 },
    ]);
  });

  it('a booster one ring further than its own reach does not contribute', () => {
    const tiles = mkTiles([
      [0, 0, 'lumberjack', 1],
      [4, 0, 'sawmill', 19], // distance 4 > radius(19) = 3
    ]);
    const report = computeProduction(tiles);
    const jack = report.producers[hexKey(0, 0)];
    expect(jack.boostPct).toBe(0);
    expect(jack.boosters).toEqual([]);
  });
});

describe('scanned = 1 + 3r(r+1)', () => {
  it('matches cellsWithin(radius) at every radius step', () => {
    const cases: Array<[number, number]> = [
      [1, 1],
      [6, 1],
      [7, 2],
      [18, 2],
      [19, 3],
    ];
    for (const [level, expectedRadius] of cases) {
      const tiles = mkTiles([[0, 0, 'lumberjack', level]]);
      const report = computeProduction(tiles);
      const jack = report.producers[hexKey(0, 0)];
      expect(jack.radius).toBe(expectedRadius);
      expect(jack.scanned).toBe(cellsWithin(expectedRadius));
      expect(jack.scanned).toBe(1 + 3 * expectedRadius * (expectedRadius + 1));
    }
  });
});

describe('worked-set ordering: nearest-first, ties by (q, r)', () => {
  it('a level-2 lumberjack with all six radius-1 forests works the first two by (q, r)', () => {
    const dirs: Array<[number, number]> = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ];
    const tiles = mkTiles([
      ...dirs.map((d) => [d[0], d[1], 'forest'] as [number, number, BuildingId, number?]),
      [0, 0, 'lumberjack', 2],
    ]);
    const report = computeProduction(tiles);
    const jack = report.producers[hexKey(0, 0)];
    expect(jack.eligible).toBe(6);
    expect(jack.worked).toBe(2);
    expect(jack.workedFields).toEqual([
      { q: -1, r: 0 },
      { q: -1, r: 1 },
    ]);
    // Production never depends on the display-only worked set; it only depends on the count.
    expect(jack.production).toBe(jack.worked * jack.yieldPerField);
  });
});
