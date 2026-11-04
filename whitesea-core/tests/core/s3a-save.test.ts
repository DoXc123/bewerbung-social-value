// S3a.2 — save v2: round-trip (with pausedAt), v1 → v2 migration, a corrupt sea block → fresh sea.
import { describe, expect, it } from 'vitest';
import { GAME_SAVE_KEY, SAVE_KEY, SPAWN_POS } from '../../src/core/config';
import { advanceGame, applySea, newGame, newSea } from '../../src/core/game';
import { deserialize, deserializeGame, migrate, serialize, serializeGame } from '../../src/core/save';
import { apply, newIsland } from '../../src/core/sim';
import type { GameState, PlaceItem } from '../../src/core/types';

function busyUnderway(): GameState {
  let g = newGame();
  const c = g.island.tiles['0,0'];
  g = { ...g, island: { ...g.island, tiles: { ...g.island.tiles, '0,0': { ...c, building: { id: 'mainhouse', level: 2 } } }, highWater: { mainhouse: 2 } } };
  g = { ...g, island: apply(g.island, { kind: 'placeTerrain', q: 2, r: 0, terrain: 'land' }, 0) };
  g = advanceGame(g, 45_000).state;
  g = applySea(g, { kind: 'setCourse', target: { x: 60, z: -80 } }, g.island.time);
  return advanceGame(g, 600_000).state;
}

describe('save v2', () => {
  it('serializeGame → { version: 2, savedAt, state }', () => {
    const g = newGame();
    expect(JSON.parse(serializeGame(g, 99))).toEqual({ version: 2, savedAt: 99, state: g });
  });

  it('round-trips an underway game whose place head is paused (pausedAt survives)', () => {
    const g = busyUnderway();
    expect(g.sea.island.state).toBe('underway');
    expect((g.island.queue[0] as PlaceItem).pausedAt).toBe(45_000);
    const back = deserializeGame(serializeGame(g, 1234));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.savedAt).toBe(1234);
    expect(back.value.state).toEqual(g);
    expect((back.value.state.island.queue[0] as PlaceItem).pausedAt).toBe(45_000);
  });

  it('keys: v1 key and v2 key are different', () => {
    expect(GAME_SAVE_KEY).not.toBe(SAVE_KEY);
  });

  it('errors on invalid JSON, non-objects, unknown versions and a broken island', () => {
    expect(deserializeGame('{nope').ok).toBe(false);
    expect(deserializeGame('3').ok).toBe(false);
    expect(deserializeGame(JSON.stringify({ version: 9, savedAt: 0, state: {} })).ok).toBe(false);
    expect(deserializeGame(JSON.stringify({ savedAt: 0, state: {} })).ok).toBe(false);
    const bad = { version: 2, savedAt: 0, state: { island: { time: -1 }, sea: newSea() } };
    expect(deserializeGame(JSON.stringify(bad)).ok).toBe(false);
    expect(deserializeGame(JSON.stringify({ version: 2, savedAt: 0, state: {} })).ok).toBe(false);
  });
});

describe('v1 → v2 migration', () => {
  it('the v1 state becomes `island`; the sea is fresh, holding at SPAWN_POS', () => {
    const island = { ...newIsland(), time: 12_345 };
    const res = deserializeGame(serialize(island, 777));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.version).toBe(2);
    expect(res.value.savedAt).toBe(777);
    expect(res.value.state.island).toEqual(island);
    expect(res.value.state.sea).toEqual(newSea());
    expect(res.value.state.sea.island.state).toBe('holding');
    expect(res.value.state.sea.island.pos).toEqual(SPAWN_POS);
  });

  it('a malformed v1 island still fails the load', () => {
    expect(deserializeGame(JSON.stringify({ version: 1, savedAt: 0, state: { time: -1 } })).ok).toBe(false);
  });

  it("the v1 reader is untouched: `migrate` stays empty and `deserialize` still reads v1 only", () => {
    expect(Object.keys(migrate)).toHaveLength(0);
    expect(deserialize(serializeGame(newGame(), 0)).ok).toBe(false);
  });
});

describe('a corrupt sea block', () => {
  const island = { ...newIsland(), time: 5_000 };
  const load = (sea: unknown) => deserializeGame(JSON.stringify({ version: 2, savedAt: 5, state: { island, sea } }));

  const corrupt: [string, unknown][] = [
    ['missing', undefined],
    ['not an object', 'lake'],
    ['no mover', { worldSeed: 1, worldVersion: 0, nextId: 1 }],
    ['bad state', { ...newSea(), island: { ...newSea().island, state: 'sinking' } }],
    ['NaN pos', { ...newSea(), island: { ...newSea().island, pos: { x: 'a', z: 0 } } }],
    ['underway without legs', { ...newSea(), island: { state: 'underway', pos: { x: 0, z: 0 }, path: [], departAt: 0, legs: [] } }],
    [
      'legs run backwards',
      {
        ...newSea(),
        island: {
          state: 'underway', pos: { x: 0, z: 0 }, departAt: 10,
          path: [{ x: 0, z: 0 }, { x: 5, z: 0 }], legs: [{ tStart: 10, tEnd: 3 }],
        },
      },
    ],
    ['non-integer nextId', { ...newSea(), nextId: 1.5 }],
  ];
  for (const [name, sea] of corrupt) {
    it(`${name} → a fresh holding sea, the island kept`, () => {
      const res = load(sea);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.state.island).toEqual(island);
      expect(res.value.state.sea).toEqual(newSea());
    });
  }

  it('a valid underway sea is kept', () => {
    const g = busyUnderway();
    const res = load(g.sea);
    expect(res.ok && res.value.state.sea).toEqual(g.sea);
  });
});
