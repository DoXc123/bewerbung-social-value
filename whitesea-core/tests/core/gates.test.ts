// Acceptance 4 (W1.md): every unlock row of §3.5, the booster high-water gate (and that it
// survives a demolish, since it only ever reads the highWater map, never current tiles), the
// town hall above L5 vs. village-centre levels, and max levels.
import { describe, expect, it } from 'vitest';
import { levelReason, unlockReason } from '../../src/core/gates';
import type { BuildingId } from '../../src/core/types';

describe('§3.5 unlock table', () => {
  const rows: Array<[BuildingId, number]> = [
    ['forest', 1],
    ['lumberjack', 1],
    // §8 pass 2026-09-24: TH1, standing in for the cut fishery (the reference design has them at TH5)
    ['wheatfield', 1],
    ['farm', 1],
    ['warehouse', 2],
    ['irondeposit', 3],
    ['oremine', 3],
    ['villagecentre', 5],
    ['quarry', 6],
    ['stonemason', 6],
    ['house', 7],
  ];
  for (const [id, need] of rows) {
    it(`${id} needs TH ${need}`, () => {
      expect(unlockReason(id, need - 1, {})).toEqual({ code: 'lockedByTownHall', need });
      expect(unlockReason(id, need, {})).toBeNull();
    });
  }
});

describe('booster high-water gate', () => {
  const rows: Array<[BuildingId, BuildingId, number]> = [
    ['sawmill', 'lumberjack', 3],
    ['bakery', 'farm', 7],
    ['stonegrindery', 'stonemason', 7],
    ['ironsmelter', 'oremine', 7],
  ];
  for (const [booster, producer, need] of rows) {
    it(`${booster} needs ${producer} to have ever reached L${need}`, () => {
      expect(unlockReason(booster, 25, { [producer]: need - 1 })).toEqual({
        code: 'lockedByBuilding',
        building: producer,
        level: need,
      });
      expect(unlockReason(booster, 25, { [producer]: need })).toBeNull();
    });
  }

  it('survives a demolish: only the high-water map matters, not current level', () => {
    // A producer that reached L3 and was demolished back to nothing still shows highWater 3.
    expect(unlockReason('sawmill', 25, { lumberjack: 3 })).toBeNull();
    expect(unlockReason('sawmill', 25, {})).toEqual({
      code: 'lockedByBuilding',
      building: 'lumberjack',
      level: 3,
    });
  });
});

describe('mainhouse: townHallPermanent, never a lockedByTownHall row', () => {
  it('unlockReason is always townHallPermanent regardless of level/highWater', () => {
    expect(unlockReason('mainhouse', 0, {})).toEqual({ code: 'townHallPermanent' });
    expect(unlockReason('mainhouse', 25, { mainhouse: 25 })).toEqual({ code: 'townHallPermanent' });
  });
});

describe('the town hall above L5 needs the highest village-centre level >= target - 5', () => {
  it('L6 needs VC >= 1', () => {
    expect(levelReason('mainhouse', 6, 5, 0)).toEqual({
      code: 'lockedByBuilding',
      building: 'villagecentre',
      level: 1,
    });
    expect(levelReason('mainhouse', 6, 5, 1)).toBeNull();
  });
  it('L9 needs VC >= 4', () => {
    expect(levelReason('mainhouse', 9, 8, 3)).toEqual({
      code: 'lockedByBuilding',
      building: 'villagecentre',
      level: 4,
    });
    expect(levelReason('mainhouse', 9, 8, 4)).toBeNull();
  });
  it('L20 needs VC >= 15 (the VC max since S0.3), so TH 21 is gated: TH effectively caps at 20', () => {
    expect(levelReason('mainhouse', 20, 19, 14)).toEqual({
      code: 'lockedByBuilding',
      building: 'villagecentre',
      level: 15,
    });
    expect(levelReason('mainhouse', 20, 19, 15)).toBeNull();
    expect(levelReason('mainhouse', 21, 20, 15)).toEqual({
      code: 'lockedByBuilding',
      building: 'villagecentre',
      level: 16,
    });
    expect(levelReason('villagecentre', 16, 25, 15)).toEqual({ code: 'maxLevel', max: 15 });
  });
  it('L5 and below need no village centre', () => {
    expect(levelReason('mainhouse', 5, 4, 0)).toBeNull();
  });
});

describe('non-TH buildings are capped by the current TH level', () => {
  it('a target above thLevel is lockedByTownHall{need: targetLevel}', () => {
    expect(levelReason('lumberjack', 5, 4, 0)).toEqual({ code: 'lockedByTownHall', need: 5 });
    expect(levelReason('lumberjack', 5, 5, 0)).toBeNull();
  });
});

describe('max levels', () => {
  it('producers cap at 25', () => {
    expect(levelReason('lumberjack', 26, 26, 0)).toEqual({ code: 'maxLevel', max: 25 });
    expect(levelReason('lumberjack', 25, 25, 0)).toBeNull();
  });
  it('boosters cap at 20', () => {
    expect(levelReason('sawmill', 21, 25, 0)).toEqual({ code: 'maxLevel', max: 20 });
  });
  it('village centre caps at 15 (S0.3; was 4)', () => {
    expect(levelReason('villagecentre', 15, 25, 0)).toBeNull();
    expect(levelReason('villagecentre', 16, 25, 0)).toEqual({ code: 'maxLevel', max: 15 });
  });
  it('fields cap at 1', () => {
    expect(levelReason('forest', 2, 25, 0)).toEqual({ code: 'maxLevel', max: 1 });
  });
});
