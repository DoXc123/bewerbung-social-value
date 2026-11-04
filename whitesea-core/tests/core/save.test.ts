// W2b acceptance 6: save round-trips a busy mid-game state; unknown version → error.
import { describe, expect, it } from 'vitest';
import { deserialize, migrate, serialize } from '../../src/core/save';
import { RES_SCALE, SAVE_SCHEMA_VERSION } from '../../src/core/types';
import type { IslandState } from '../../src/core/types';

/** A hand-built busy mid-game state: queued upgrade + waiting build, fixed-point treasury, highWater. */
function busyMidGameState(): IslandState {
  return {
    time: 5_000,
    mode: 'island',
    tiles: {
      '0,0': { q: 0, r: 0, terrain: 'land', seed: true, building: { id: 'mainhouse', level: 2 } },
      '1,0': { q: 1, r: 0, terrain: 'land', seed: true, building: { id: 'forest', level: 1 } },
      '2,0': { q: 2, r: 0, terrain: 'land', seed: false, building: { id: 'lumberjack', level: 3 } },
      '3,0': { q: 3, r: 0, terrain: 'land', seed: false, building: null },
    },
    treasury: {
      wood: 120 * RES_SCALE + 500_000,
      food: 80 * RES_SCALE,
      stone: 0,
      iron: 5 * RES_SCALE,
    },
    population: 2 * RES_SCALE,
    pieces: { land: 6, mountain: 4 },
    queue: [
      {
        id: 1,
        kind: 'upgrade',
        q: 2,
        r: 0,
        building: 'lumberjack',
        level: 4,
        paid: { wood: 40, food: 0, stone: 0, iron: 0 },
        durationMs: 3_600_000,
        startedAt: 1_000,
      },
      {
        id: 2,
        kind: 'build',
        q: 3,
        r: 0,
        building: 'forest',
        level: 1,
        paid: { wood: 40, food: 20, stone: 0, iron: 0 },
        durationMs: 1_800_000,
        startedAt: null,
      },
    ],
    highWater: { mainhouse: 2, forest: 1, lumberjack: 3 },
    nextItemId: 3,
  };
}

describe('save', () => {
  it('round-trips a busy mid-game state', () => {
    const state = busyMidGameState();
    const savedAt = 1_758_758_400_000;
    const json = serialize(state, savedAt);
    const result = deserialize(json);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.version).toBe(SAVE_SCHEMA_VERSION);
    expect(result.value.savedAt).toBe(savedAt);
    expect(result.value.state).toEqual(state);
  });

  it('errors on an unknown/future version', () => {
    const json = JSON.stringify({ version: 2, savedAt: 0, state: {} });
    const result = deserialize(json);
    expect(result.ok).toBe(false);
  });

  it('errors on missing version (migrate table is empty today)', () => {
    expect(Object.keys(migrate)).toHaveLength(0);
    const json = JSON.stringify({ savedAt: 0, state: {} });
    const result = deserialize(json);
    expect(result.ok).toBe(false);
  });

  it('errors on invalid JSON', () => {
    const result = deserialize('{not json');
    expect(result.ok).toBe(false);
  });

  it('errors on a malformed state shape', () => {
    const json = JSON.stringify({ version: 1, savedAt: 0, state: { time: -1 } });
    const result = deserialize(json);
    expect(result.ok).toBe(false);
  });
});
