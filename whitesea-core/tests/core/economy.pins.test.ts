// Acceptance 2 (W1.md): port every test in unity/tests/test_economy_math.py and
// test_economy_model.py (not test_loop_costs.py — its flat MVP costs don't apply). The Unity
// pins have no town hall (Unity adds +5 wood/+5 food unconditionally); our engine only adds
// it when a mainhouse tile exists, so every layout below places one outside every reach.
//
// `TestUpgradeCost` in test_economy_math.py pins EconomyMath.UpgradeCost — the MVP
// `ceil(buildBaseCost * level * slope)` cost model. That model has no counterpart in our
// contract (economy.ts exports no upgradeCost; our real cost model is costtime.ts's
// formula, tested elsewhere), so it is out of scope here for
// the same reason test_loop_costs.py is: it's a different, MVP-only cost curve.
import { describe, expect, it } from 'vitest';
import { getDef } from '../../src/core/catalog';
import { baseYield, boostedYield, computeProduction, radius } from '../../src/core/economy';
import { hexKey, spiral } from '../../src/core/hex';
import type { BuildingId, HexKey, Tile } from '../../src/core/types';

const FAR = { q: 1000, r: 1000 };

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

function withMainhouse(records: Array<[number, number, BuildingId, number?]>) {
  return mkTiles([...records, [FAR.q, FAR.r, 'mainhouse', 1]]);
}

describe('TestBaseYield', () => {
  it('piecewise boundaries', () => {
    expect(baseYield(6)).toBe(15);
    expect(baseYield(7)).toBe(16);
    expect(baseYield(18)).toBe(27);
    expect(baseYield(19)).toBe(27);
    expect(baseYield(20)).toBe(28);
  });
  it('level one and clamp', () => {
    expect(baseYield(1)).toBe(5);
    expect(baseYield(0)).toBe(5);
    expect(baseYield(-3)).toBe(5);
  });
});

describe('TestRadiusForLevel', () => {
  it('step function', () => {
    for (const level of [1, 6]) expect(radius(level)).toBe(1);
    for (const level of [7, 18]) expect(radius(level)).toBe(2);
    for (const level of [19, 40]) expect(radius(level)).toBe(3);
  });
});

describe('TestApplyBoost', () => {
  it('ceil gives small bases at least one', () => {
    expect(boostedYield(5, 5)).toBe(6);
  });
  it('zero boost is identity', () => {
    expect(boostedYield(5, 0)).toBe(5);
  });
});

describe('TestWorkedFields (ported via computeProduction)', () => {
  it('level caps worked: 2 eligible, level 1 -> worked 1', () => {
    const tiles = withMainhouse([
      [1, 0, 'forest'],
      [0, 1, 'forest'],
      [0, 0, 'lumberjack', 1],
    ]);
    const report = computeProduction(tiles);
    expect(report.producers[hexKey(0, 0)].worked).toBe(1);
  });
  it('level caps worked: 10 eligible, level 7 -> worked 7', () => {
    const ring = spiral({ q: 0, r: 0 }, 2).slice(1, 11); // 10 non-centre cells
    const records: Array<[number, number, BuildingId, number?]> = ring.map(
      (c) => [c.q, c.r, 'forest'] as [number, number, BuildingId, number?],
    );
    records.push([0, 0, 'lumberjack', 7]);
    const report = computeProduction(withMainhouse(records));
    const jack = report.producers[hexKey(0, 0)];
    expect(jack.eligible).toBe(10);
    expect(jack.worked).toBe(7);
  });
  it('fields below cap pass through: 1 eligible, level 7 -> worked 1', () => {
    const tiles = withMainhouse([
      [1, 0, 'forest'],
      [0, 0, 'lumberjack', 7],
    ]);
    const report = computeProduction(tiles);
    expect(report.producers[hexKey(0, 0)].worked).toBe(1);
  });
});

// M2 seed puzzle: 1 lumberjack + 2 forests in reach.
function m2Layout(jackLevel: number): Array<[number, number, BuildingId, number?]> {
  return [
    [1, 0, 'forest'],
    [0, 1, 'forest'],
    [0, 0, 'lumberjack', jackLevel],
  ];
}

describe('TestM2Seed', () => {
  it('L1 worked cap binds: badge 1/2/7 -> 5 wood, total 10', () => {
    const report = computeProduction(withMainhouse(m2Layout(1)));
    const jack = report.producers[hexKey(0, 0)];
    expect([jack.worked, jack.eligible, jack.scanned]).toEqual([1, 2, 7]);
    expect(jack.production).toBe(5);
    expect(report.perHour.wood).toBe(10);
  });

  it('L7 radius grows and second field works: badge 2/2/19 -> 32 wood, total 37', () => {
    const report = computeProduction(withMainhouse(m2Layout(7)));
    const jack = report.producers[hexKey(0, 0)];
    expect([jack.worked, jack.eligible, jack.scanned]).toEqual([2, 2, 19]);
    expect(jack.radius).toBe(2);
    expect(jack.production).toBe(32);
    expect(report.perHour.wood).toBe(37);
  });
});

// M3 seed: wood chain (lumberjack + 2 forests + sawmill) vs. a food chain (farm + 2
// wheatfields), far enough apart not to interact.
function m3Layout(
  jackLevel: number,
  withBakery = false,
): Array<[number, number, BuildingId, number?]> {
  const placed: Array<[number, number, BuildingId, number?]> = [
    [0, 0, 'lumberjack', jackLevel],
    [1, 0, 'forest'],
    [0, 1, 'forest'],
    [-1, 0, 'sawmill', 1],
    [10, 0, 'farm', 1],
    [11, 0, 'wheatfield'],
    [10, 1, 'wheatfield'],
  ];
  if (withBakery) placed.push([9, 0, 'bakery', 1]);
  return placed;
}

describe('TestM3Seed', () => {
  it('L1 default: wood 11, food 10; lumberjack yield 6 (+5%)', () => {
    const report = computeProduction(withMainhouse(m3Layout(1)));
    expect(report.perHour.wood).toBe(11);
    expect(report.perHour.food).toBe(10);
    const jack = report.producers[hexKey(0, 0)];
    expect(jack.yieldPerField).toBe(6);
    expect(jack.boostPct).toBe(5);
  });

  it('L7 scrub: wood 39; 2/2 at yield 17 (+5%) = 34; food unchanged', () => {
    const report = computeProduction(withMainhouse(m3Layout(7)));
    expect(report.perHour.wood).toBe(39);
    expect(report.perHour.food).toBe(10);
    const jack = report.producers[hexKey(0, 0)];
    expect(jack.yieldPerField).toBe(17);
    expect(jack.production).toBe(34);
  });

  it('bakery generalises boost: farm +5%, yield 5->6, food 11', () => {
    const report = computeProduction(withMainhouse(m3Layout(1, true)));
    expect(report.perHour.food).toBe(11);
    const farm = report.producers[hexKey(10, 0)];
    expect(farm.yieldPerField).toBe(6);
  });
});

describe('TestCanonicalDemo', () => {
  it('six forests six lumberjacks -> 35 wood/h', () => {
    const dirs: Array<[number, number]> = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ];
    const records: Array<[number, number, BuildingId, number?]> = [];
    for (const [dq, dr] of dirs) {
      records.push([dq, dr, 'forest']);
      records.push([dq * 2, dr * 2, 'lumberjack', 1]);
    }
    const report = computeProduction(withMainhouse(records));
    expect(report.perHour.wood).toBe(35);
  });
});

describe('§3.3 "must include" extra: forest + L1 lumberjack + L2 sawmill + TH = 11 wood/h', () => {
  it('5 -> ceil(5.5) = 6, + 5 baseline', () => {
    const report = computeProduction(
      withMainhouse([
        [1, 0, 'forest'],
        [0, 0, 'lumberjack', 1],
        [-1, 0, 'sawmill', 2],
      ]),
    );
    const jack = report.producers[hexKey(0, 0)];
    expect(jack.yieldPerField).toBe(6);
    expect(report.perHour.wood).toBe(11);
  });
});

describe('TestBaseline', () => {
  it('an island with only a mainhouse produces wood 5 / food 5', () => {
    const report = computeProduction(mkTiles([[0, 0, 'mainhouse', 1]]));
    expect(report.perHour.wood).toBe(5);
    expect(report.perHour.food).toBe(5);
  });
});
