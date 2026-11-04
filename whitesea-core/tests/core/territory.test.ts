// Acceptance 5 (W1.md): territory sphere, storage/population capacity, connectivity and
// buildable cells.
//
// NOTE on the "1450" example in W1.md: the spec's own per-level list (250, 550, 900, 1300,
// 1750 at L1-L5) gives an L1+L3 warehouse combination of 500+250+900 = 1650, not 1450 (1450
// is what an L2+L3 pair would give: 500+550+900). Implemented and tested against the
// per-level list and the ONESHOT/mapmaster-tool §4.4 formula, which agree with each other;
// flagged under "Questions for the owner" in the run report rather than guessed away.
import { describe, expect, it } from 'vitest';
import { getDef } from '../../src/core/catalog';
import { capacity, isConnected, storageCap, territorySet, buildableCells } from '../../src/core/territory';
import { hexKey, ring, spiral } from '../../src/core/hex';
import type { BuildingId, HexKey, IslandState, Tile } from '../../src/core/types';

function mkTiles(records: Array<[number, number, BuildingId?, number?]>): Record<HexKey, Tile> {
  const tiles: Record<HexKey, Tile> = {};
  for (const [q, r, building, level] of records) {
    tiles[hexKey(q, r)] = {
      q,
      r,
      terrain: building ? getDef(building).terrain : 'land',
      seed: false,
      building: building ? { id: building, level: level ?? 1 } : null,
    };
  }
  return tiles;
}

function mkState(tiles: Record<HexKey, Tile>, pieces = { land: 10, mountain: 10 }): IslandState {
  return {
    time: 0,
    mode: 'island',
    tiles,
    treasury: { wood: 0, food: 0, stone: 0, iron: 0 },
    population: 0,
    pieces,
    queue: [],
    highWater: {},
    nextItemId: 1,
  };
}

describe('territorySet', () => {
  it('an L4 sphere has exactly 61 cells', () => {
    const tiles = mkTiles([[0, 0, 'mainhouse', 4]]);
    expect(territorySet(tiles).size).toBe(61);
  });

  it('TH1 territory is exactly the 7-hex seed', () => {
    const tiles = mkTiles([[0, 0, 'mainhouse', 1]]);
    const set = territorySet(tiles);
    expect(set.size).toBe(7);
    for (const c of spiral({ q: 0, r: 0 }, 1)) expect(set.has(hexKey(c.q, c.r))).toBe(true);
  });

  it('is the union of the TH sphere and every VC sphere', () => {
    const tiles = mkTiles([
      [0, 0, 'mainhouse', 1],
      [10, 0, 'villagecentre', 1],
    ]);
    const set = territorySet(tiles);
    expect(set.size).toBe(14); // no overlap: 7 + 7
    expect(set.has(hexKey(10, 0))).toBe(true);
  });
});

describe('storageCap', () => {
  it('one warehouse contributes 25*L*(9+L): 250/550/900/1300/1750 at L1-L5, 4750 at L10, 21250 at L25', () => {
    expect(storageCap(mkTiles([[0, 0, 'warehouse', 1]]))).toBe(500 + 250);
    expect(storageCap(mkTiles([[0, 0, 'warehouse', 2]]))).toBe(500 + 550);
    expect(storageCap(mkTiles([[0, 0, 'warehouse', 3]]))).toBe(500 + 900); // never 901
    expect(storageCap(mkTiles([[0, 0, 'warehouse', 4]]))).toBe(500 + 1300);
    expect(storageCap(mkTiles([[0, 0, 'warehouse', 5]]))).toBe(500 + 1750);
    expect(storageCap(mkTiles([[0, 0, 'warehouse', 10]]))).toBe(500 + 4750);
    expect(storageCap(mkTiles([[0, 0, 'warehouse', 25]]))).toBe(500 + 21_250);
  });

  it('500 with no warehouse', () => {
    expect(storageCap(mkTiles([[0, 0, 'mainhouse', 1]]))).toBe(500);
  });

  it('750 with one L1 warehouse', () => {
    expect(storageCap(mkTiles([[0, 0, 'warehouse', 1]]))).toBe(750);
  });

  it('1650 with an L1 and an L3 (500 + 250 + 900)', () => {
    const tiles = mkTiles([
      [0, 0, 'warehouse', 1],
      [1, 0, 'warehouse', 3],
    ]);
    expect(storageCap(tiles)).toBe(1650);
  });
});

describe('capacity', () => {
  it('population growth and cap', () => {
    const tiles = mkTiles([
      [0, 0, 'mainhouse', 1],
      [1, 0, 'house', 2],
      [2, 0, 'house', 3],
    ]);
    const rep = capacity(tiles);
    expect(rep.populationPerHour).toBe(2 + 2);
    expect(rep.populationCap).toBe(500 + 500 * (2 + 3));
  });

  it('townHallLevel, villageCentreLevel (highest), islandCap, islandSize', () => {
    const tiles = mkTiles([
      [0, 0, 'mainhouse', 3],
      [1, 0, 'villagecentre', 1],
      [-1, 0, 'villagecentre', 2],
      [2, 0],
    ]);
    const rep = capacity(tiles);
    expect(rep.townHallLevel).toBe(3);
    expect(rep.villageCentreLevel).toBe(2);
    expect(rep.islandCap).toBe(60);
    expect(rep.islandSize).toBe(4);
  });
});

describe('isConnected', () => {
  it('an interior hole (missing centre, annulus intact) is still connected', () => {
    const cells = spiral({ q: 0, r: 0 }, 2).filter((c) => !(c.q === 0 && c.r === 0));
    const records: Array<[number, number, BuildingId?, number?]> = cells.map((c) => [c.q, c.r]);
    // Put the mainhouse on a ring-1 cell (the true centre is the hole).
    records[0] = [records[0][0], records[0][1], 'mainhouse', 1];
    expect(isConnected(mkTiles(records))).toBe(true);
  });

  it('a detached tile makes the island split (disconnected)', () => {
    const tiles = mkTiles([
      [0, 0, 'mainhouse', 1],
      [1, 0],
      [-1, 0],
      [50, 50], // far away, not adjacent to anything
    ]);
    expect(isConnected(tiles)).toBe(false);
  });
});

describe('buildableCells', () => {
  it('the seed island (TH1) has no buildable empty cells: ring-2 is outside the TH1 territory', () => {
    const seed = spiral({ q: 0, r: 0 }, 1);
    const records: Array<[number, number, BuildingId?, number?]> = seed.map((c, i) =>
      i === 0 ? [c.q, c.r, 'mainhouse', 1] : [c.q, c.r],
    );
    const state = mkState(mkTiles(records));
    expect(buildableCells(state)).toEqual([]);
  });

  it('the 12 ring-2 cells appear once the TH is L2', () => {
    const seed = spiral({ q: 0, r: 0 }, 1);
    const records: Array<[number, number, BuildingId?, number?]> = seed.map((c, i) =>
      i === 0 ? [c.q, c.r, 'mainhouse', 2] : [c.q, c.r],
    );
    const state = mkState(mkTiles(records));
    const expected = ring({ q: 0, r: 0 }, 2)
      .map((c) => ({ q: c.q, r: c.r }))
      .sort((a, b) => a.r - b.r || a.q - b.q);
    expect(buildableCells(state)).toEqual(expected);
  });

  it('no pieces available means no buildable cells even inside territory', () => {
    const seed = spiral({ q: 0, r: 0 }, 1);
    const records: Array<[number, number, BuildingId?, number?]> = seed.map((c, i) =>
      i === 0 ? [c.q, c.r, 'mainhouse', 2] : [c.q, c.r],
    );
    const state = mkState(mkTiles(records), { land: 0, mountain: 0 });
    expect(buildableCells(state)).toEqual([]);
  });
});
