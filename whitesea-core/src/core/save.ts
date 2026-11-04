/**
 * save.ts — the island JSON save (ONESHOT §3.8): schema-versioned, with a migration hook.
 * Never touches storage — the game layer owns `localStorage` and `SAVE_KEY` (config.ts).
 */
import { newSea } from './game';
import { RESOURCES, SAVE_SCHEMA_VERSION, TERRAIN_IDS } from './types';
import type {
  DeserializeFn, DeserializeGameFn, IslandState, Mover, Result, SaveFile, SaveFileV1, SaveFileV2, SeaState, SerializeFn,
  SerializeGameFn,
} from './types';

/** The current (GameState) save version; v1 is the island-only save `deserialize` still reads. */
export const GAME_SAVE_VERSION = 2 as const;

export const serialize: SerializeFn = (state, savedAt) => {
  const file: SaveFileV1 = { version: SAVE_SCHEMA_VERSION, savedAt, state };
  return JSON.stringify(file);
};

/**
 * Keyed by source version; each entry upgrades one version forward to the next.
 * Empty today (schema version 1 is the only one that has ever shipped).
 */
export const migrate: Record<number, (old: Record<string, unknown>) => Record<string, unknown>> = {};

export const deserialize: DeserializeFn = (json: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'save: invalid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'save: not an object' };
  }

  let file = parsed as Record<string, unknown>;
  const seenVersions = new Set<unknown>();
  while (file.version !== SAVE_SCHEMA_VERSION) {
    const version = file.version;
    if (seenVersions.has(version)) {
      return { ok: false, error: `save: migration loop at version ${String(version)}` };
    }
    seenVersions.add(version);
    const step = typeof version === 'number' ? migrate[version] : undefined;
    if (!step) {
      return { ok: false, error: `save: unknown or unsupported version ${String(version)}` };
    }
    file = step(file);
  }

  const shapeError = validateShape(file);
  if (shapeError) return { ok: false, error: shapeError };

  return { ok: true, value: file as unknown as SaveFile };
};

function validateShape(file: Record<string, unknown>): string | null {
  if (typeof file.savedAt !== 'number') return 'save: savedAt must be a number';

  const state = file.state;
  if (typeof state !== 'object' || state === null) return 'save: state must be an object';
  return validateIsland(state as Record<string, unknown>, 'state');
}

function validateIsland(s: Record<string, unknown>, at: string): string | null {
  if (!Number.isInteger(s.time) || (s.time as number) < 0) {
    return `save: ${at}.time must be a non-negative integer`;
  }
  if (s.mode !== 'island' && s.mode !== 'openSkies') return `save: ${at}.mode is invalid`;
  if (typeof s.tiles !== 'object' || s.tiles === null) return `save: ${at}.tiles must be an object`;

  const treasury = s.treasury;
  if (typeof treasury !== 'object' || treasury === null) return `save: ${at}.treasury must be an object`;
  for (const r of RESOURCES) {
    if (typeof (treasury as Record<string, unknown>)[r] !== 'number') {
      return `save: ${at}.treasury.${r} must be a number`;
    }
  }

  if (typeof s.population !== 'number') return `save: ${at}.population must be a number`;

  const pieces = s.pieces;
  if (typeof pieces !== 'object' || pieces === null) return `save: ${at}.pieces must be an object`;
  for (const t of TERRAIN_IDS) {
    if (typeof (pieces as Record<string, unknown>)[t] !== 'number') {
      return `save: ${at}.pieces.${t} must be a number`;
    }
  }

  if (!Array.isArray(s.queue)) return `save: ${at}.queue must be an array`;
  if (typeof s.highWater !== 'object' || s.highWater === null) return `save: ${at}.highWater must be an object`;
  if (!Number.isInteger(s.nextItemId)) return `save: ${at}.nextItemId must be an integer`;

  return null;
}

// ─────────────────────────────────────────────────────────────── v2 (S3a): the GameState save

export const serializeGame: SerializeGameFn = (state, savedAt) => {
  const file: SaveFileV2 = { version: GAME_SAVE_VERSION, savedAt, state };
  return JSON.stringify(file);
};

/**
 * Keyed by source version, upgrading one version forward, for the GameState save. A separate table
 * from `migrate` (which is the v1 reader's and stays empty: v1 has nothing before it).
 * v1 → v2: the island state becomes `island`; the sea is fresh (holding at SPAWN_POS).
 */
export const migrateGame: Record<number, (old: Record<string, unknown>) => Record<string, unknown>> = {
  1: (old) => ({ ...old, version: 2, state: { island: old.state, sea: newSea() } }),
};

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isVec(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return isFiniteNum(p.x) && isFiniteNum(p.z);
}

/** Shape-check a sea block. A bad one is replaced (never fails the load — the island matters more). */
function isValidSea(v: unknown): v is SeaState {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (!Number.isInteger(s.worldSeed) || !Number.isInteger(s.worldVersion) || !Number.isInteger(s.nextId)) return false;
  const m = s.island as Mover | null | undefined;
  if (typeof m !== 'object' || m === null || !isVec(m.pos)) return false;
  if (m.state === 'holding') return true;
  if (m.state !== 'underway') return false;
  if (!Number.isInteger(m.departAt) || !Array.isArray(m.path) || !Array.isArray(m.legs)) return false;
  if (m.path.length < 2 || m.legs.length !== m.path.length - 1) return false;
  if (!m.path.every(isVec)) return false;
  let prev = m.departAt;
  for (const leg of m.legs) {
    if (typeof leg !== 'object' || leg === null) return false;
    if (!Number.isInteger(leg.tStart) || !Number.isInteger(leg.tEnd) || leg.tStart < prev || leg.tEnd < leg.tStart) return false;
    prev = leg.tEnd;
  }
  return true;
}

export const deserializeGame: DeserializeGameFn = (json: string): Result<SaveFileV2> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: 'save: invalid JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'save: not an object' };
  }

  let file = parsed as Record<string, unknown>;
  const seenVersions = new Set<unknown>();
  while (file.version !== GAME_SAVE_VERSION) {
    const version = file.version;
    if (seenVersions.has(version)) {
      return { ok: false, error: `save: migration loop at version ${String(version)}` };
    }
    seenVersions.add(version);
    const step = typeof version === 'number' ? migrateGame[version] : undefined;
    if (!step) {
      return { ok: false, error: `save: unknown or unsupported version ${String(version)}` };
    }
    file = step(file);
  }

  if (typeof file.savedAt !== 'number') return { ok: false, error: 'save: savedAt must be a number' };
  const state = file.state;
  if (typeof state !== 'object' || state === null) return { ok: false, error: 'save: state must be an object' };
  const game = state as Record<string, unknown>;
  const island = game.island;
  if (typeof island !== 'object' || island === null) return { ok: false, error: 'save: state.island must be an object' };
  const shapeError = validateIsland(island as Record<string, unknown>, 'state.island');
  if (shapeError) return { ok: false, error: shapeError };

  const sea = isValidSea(game.sea) ? game.sea : newSea();
  return {
    ok: true,
    value: { version: GAME_SAVE_VERSION, savedAt: file.savedAt, state: { island: island as IslandState, sea } },
  };
};
