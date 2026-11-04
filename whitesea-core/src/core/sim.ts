/**
 * sim.ts — island construction (`newIsland`, `stateFromLayout`) and the pure command triad
 * `project` / `validate` / `apply` (ONESHOT §3.6–§3.7, §4; semantics pinned in web/PLAN.md
 * "Decisions taken under §6"). Timed commands (build/upgrade/demolish, and placeTerrain since
 * Open Sea S0.1) validate against the *projected* state (the queue run to completion); instant
 * commands (removeTerrain, cancel) validate against the *actual* state and are refused `busy`
 * when a replay of the queue on the result would fail. Terrain pieces are capped at PIECE_CAP
 * (S0.2, core/pieces.ts).
 */
import { getDef } from './catalog';
import {
  MAX_QUEUE,
  PIECE_CAP,
  PLACE_DURATION_MS,
  SEED_CENTRE,
  SEED_RADIUS,
  SEED_TERRAIN,
  SEED_TOWN_HALL_LEVEL,
  START_POPULATION,
  START_TREASURY,
  grantTablePieceSource,
} from './config';
import { costAt, demolishMs, demolishRefund, durationMs } from './costtime';
import { levelReason, unlockReason } from './gates';
import { hexKey, neighbors } from './hex';
import { layoutToTiles } from './layout';
import { storedPieces, truncateGrant } from './pieces';
import { isQueueFull, pushItem, replayQueue, runQueue, cancelItem as cancelQueueItem } from './queue';
import { capacity, isConnected, placeReason, storageCap } from './territory';
import { RES_SCALE, RESOURCES } from './types';
import type {
  ApplyFn,
  BuildingId,
  Command,
  Fixed,
  GameMs,
  HexKey,
  IslandState,
  Layout,
  PieceSource,
  ProjectFn,
  Quote,
  Reason,
  ResourceVec,
  Resource,
  QueueItem,
  TerrainId,
  Tile,
  ValidateFn,
  Verdict,
} from './types';

function zeroVec(): ResourceVec {
  return { wood: 0, food: 0, stone: 0, iron: 0 };
}

// ─────────────────────────────────────────────────────────────── construction

export function newIsland(pieces: PieceSource = grantTablePieceSource): IslandState {
  const tiles: Record<HexKey, Tile> = {};
  const centre = SEED_CENTRE;
  tiles[hexKey(centre.q, centre.r)] = {
    q: centre.q,
    r: centre.r,
    terrain: SEED_TERRAIN,
    seed: true,
    building: { id: 'mainhouse', level: SEED_TOWN_HALL_LEVEL },
  };
  for (const n of neighbors(centre)) {
    tiles[hexKey(n.q, n.r)] = { q: n.q, r: n.r, terrain: SEED_TERRAIN, seed: true, building: null };
  }

  const treasury = {} as Record<Resource, Fixed>;
  for (const r of RESOURCES) treasury[r] = START_TREASURY[r] * RES_SCALE;

  return {
    time: 0,
    mode: 'island',
    tiles,
    treasury,
    population: START_POPULATION * RES_SCALE,
    // The start grant is a grant like any other: it never lifts storage past PIECE_CAP (S0.2).
    pieces: truncateGrant(0, pieces.initial()).kept,
    queue: [],
    highWater: { mainhouse: SEED_TOWN_HALL_LEVEL },
    nextItemId: 1,
  };
}

export interface StateFromLayoutOpts {
  /** Whole units. Defaults to §6 START_TREASURY. */
  treasury?: Record<Resource, number>;
  pieces?: Record<TerrainId, number>;
  /** Defaults to SEED_RADIUS (1): cells within this distance of the mainhouse are seed. */
  seedRadius?: number;
  time?: GameMs;
}

export function stateFromLayout(layout: Layout, opts: StateFromLayoutOpts = {}): IslandState {
  const seedRadius = opts.seedRadius ?? SEED_RADIUS;
  const tiles = layoutToTiles(layout, seedRadius);

  const highWater: Partial<Record<BuildingId, number>> = {};
  for (const rec of layout) {
    if (!rec.building) continue;
    const cur = highWater[rec.building] ?? 0;
    if (rec.level > cur) highWater[rec.building] = rec.level;
  }

  const treasuryWhole = opts.treasury ?? START_TREASURY;
  const treasury = {} as Record<Resource, Fixed>;
  for (const r of RESOURCES) treasury[r] = treasuryWhole[r] * RES_SCALE;

  return {
    time: opts.time ?? 0,
    mode: 'island',
    tiles,
    treasury,
    population: 0,
    pieces: opts.pieces ?? grantTablePieceSource.initial(),
    queue: [],
    highWater,
    nextItemId: 1,
  };
}

// ─────────────────────────────────────────────────────────────── project

/**
 * The state as if every queued item had completed, in order — exactly as `advance` would complete
 * them, so a town-hall grant sees the pieces still reserved by the `place` items behind it.
 * Queue is empty in the result.
 */
export const project: ProjectFn = (state: IslandState): IslandState =>
  runQueue(state, grantTablePieceSource).state;

// ─────────────────────────────────────────────────────────────── core reasons (shared by
// validate() and the busy-replay below — the same structural checks, minus the resource /
// queue-size checks a replay must skip because that work is already paid for).

function buildCoreReason(
  tiles: Record<HexKey, Tile>,
  highWater: Partial<Record<BuildingId, number>>,
  thLevel: number,
  cmd: { q: number; r: number; building: BuildingId },
): Reason | null {
  const tile = tiles[hexKey(cmd.q, cmd.r)];
  if (!tile) return { code: 'needsTerrain' };
  if (tile.building) return { code: 'occupied' };
  const need = getDef(cmd.building).terrain;
  if (need !== tile.terrain) return { code: 'wrongTerrain', need };
  return unlockReason(cmd.building, thLevel, highWater);
}

function upgradeCoreReason(
  tiles: Record<HexKey, Tile>,
  cap: { townHallLevel: number; villageCentreLevel: number },
  cmd: { q: number; r: number },
): Reason | null {
  const tile = tiles[hexKey(cmd.q, cmd.r)];
  if (!tile) return { code: 'needsTerrain' };
  if (!tile.building) return { code: 'noBuilding' };
  const targetLevel = tile.building.level + 1;
  return levelReason(tile.building.id, targetLevel, cap.townHallLevel, cap.villageCentreLevel);
}

function demolishCoreReason(tiles: Record<HexKey, Tile>, cmd: { q: number; r: number }): Reason | null {
  const key = hexKey(cmd.q, cmd.r);
  const tile = tiles[key];
  if (!tile) return { code: 'needsTerrain' };
  if (!tile.building) return { code: 'noBuilding' };
  if (tile.building.id === 'mainhouse') return { code: 'townHallPermanent' };
  const afterTiles = { ...tiles, [key]: { ...tile, building: null } };
  const territory = new Set(capacity(afterTiles).territory);
  for (const k in afterTiles) {
    if (!territory.has(k)) return { code: 'wouldStrand' };
  }
  return null;
}

function checkQueueItem(state: IslandState, item: QueueItem): boolean {
  const cap = capacity(state.tiles);
  const tile = state.tiles[hexKey(item.q, item.r)];
  if (item.kind === 'build') {
    return !buildCoreReason(state.tiles, state.highWater, cap.townHallLevel, {
      q: item.q,
      r: item.r,
      building: item.building,
    });
  }
  if (item.kind === 'upgrade') {
    // A queued upgrade sets the level directly (applyCompletion), so it's only still legal if
    // this is still the very next level for that tile — else an earlier item it depended on
    // (a prior upgrade, or a cancel that removed one) has desynced it.
    if (!tile?.building || tile.building.level + 1 !== item.level) return false;
    return !upgradeCoreReason(state.tiles, cap, { q: item.q, r: item.r });
  }
  // A queued place re-checks the cell at its turn; its piece is already reserved (S0.1).
  if (item.kind === 'place') return !placeReason(state.tiles, item.q, item.r);
  // demolish: the refund it would pay was priced at enqueue time against a specific level.
  if (!tile?.building || tile.building.level !== item.level) return false;
  return !demolishCoreReason(state.tiles, { q: item.q, r: item.r });
}

function replayOk(state: IslandState): boolean {
  return replayQueue(state, checkQueueItem, grantTablePieceSource);
}

// ─────────────────────────────────────────────────────────────── shortfall / affordability

function shortfallVec(treasury: Record<Resource, Fixed>, costWhole: ResourceVec): ResourceVec | null {
  let any = false;
  const out = zeroVec();
  for (const r of RESOURCES) {
    const needFixed = costWhole[r] * RES_SCALE;
    const haveFixed = treasury[r];
    if (needFixed > haveFixed) {
      out[r] = Math.ceil((needFixed - haveFixed) / RES_SCALE);
      any = true;
    }
  }
  return any ? out : null;
}

function payCost(treasury: Record<Resource, Fixed>, cost: ResourceVec): Record<Resource, Fixed> {
  const out = { ...treasury };
  for (const r of RESOURCES) out[r] = out[r] - cost[r] * RES_SCALE;
  return out;
}

// ─────────────────────────────────────────────────────────────── validate

function validateBuild(state: IslandState, cmd: { q: number; r: number; building: BuildingId }): Verdict {
  const quote: Quote = {
    cost: costAt(cmd.building, 1),
    refund: zeroVec(),
    durationMs: durationMs(cmd.building, 1),
    building: cmd.building,
    level: 1,
  };
  const projected = project(state);
  const cap = capacity(projected.tiles);
  const core = buildCoreReason(projected.tiles, projected.highWater, cap.townHallLevel, cmd);
  if (core) return { ok: false, reason: core, quote };
  if (isQueueFull(state.queue)) return { ok: false, reason: { code: 'queueFull', size: MAX_QUEUE }, quote };
  const scap = storageCap(state.tiles);
  for (const r of RESOURCES) {
    if (quote.cost[r] > scap) {
      return { ok: false, reason: { code: 'exceedsStorage', resource: r, cost: quote.cost[r], cap: scap }, quote };
    }
  }
  const shortfall = shortfallVec(state.treasury, quote.cost);
  if (shortfall) return { ok: false, reason: { code: 'unaffordable', shortfall }, quote };
  return { ok: true, quote };
}

function validateUpgrade(state: IslandState, cmd: { q: number; r: number }): Verdict {
  const key = hexKey(cmd.q, cmd.r);
  const projected = project(state);
  const tile = projected.tiles[key];
  if (!tile) return { ok: false, reason: { code: 'needsTerrain' }, quote: null };
  if (!tile.building) return { ok: false, reason: { code: 'noBuilding' }, quote: null };

  const buildingId = tile.building.id;
  const targetLevel = tile.building.level + 1;
  const quote: Quote = {
    cost: costAt(buildingId, targetLevel),
    refund: zeroVec(),
    durationMs: durationMs(buildingId, targetLevel),
    building: buildingId,
    level: targetLevel,
  };

  const cap = capacity(projected.tiles);
  const core = levelReason(buildingId, targetLevel, cap.townHallLevel, cap.villageCentreLevel);
  if (core) return { ok: false, reason: core, quote };
  if (isQueueFull(state.queue)) return { ok: false, reason: { code: 'queueFull', size: MAX_QUEUE }, quote };
  const scap = storageCap(state.tiles);
  for (const r of RESOURCES) {
    if (quote.cost[r] > scap) {
      return { ok: false, reason: { code: 'exceedsStorage', resource: r, cost: quote.cost[r], cap: scap }, quote };
    }
  }
  const shortfall = shortfallVec(state.treasury, quote.cost);
  if (shortfall) return { ok: false, reason: { code: 'unaffordable', shortfall }, quote };
  return { ok: true, quote };
}

function validateDemolish(state: IslandState, cmd: { q: number; r: number }): Verdict {
  const key = hexKey(cmd.q, cmd.r);
  const projected = project(state);
  const tile = projected.tiles[key];
  if (!tile) return { ok: false, reason: { code: 'needsTerrain' }, quote: null };
  if (!tile.building) return { ok: false, reason: { code: 'noBuilding' }, quote: null };

  const buildingId = tile.building.id;
  const level = tile.building.level;
  const quote: Quote = {
    cost: zeroVec(),
    refund: demolishRefund(buildingId, level),
    durationMs: demolishMs(buildingId, level),
    building: buildingId,
    level,
  };

  if (buildingId === 'mainhouse') return { ok: false, reason: { code: 'townHallPermanent' }, quote };
  const afterTiles = { ...projected.tiles, [key]: { ...tile, building: null } };
  const territory = new Set(capacity(afterTiles).territory);
  for (const k in afterTiles) {
    if (!territory.has(k)) return { ok: false, reason: { code: 'wouldStrand' }, quote };
  }
  if (isQueueFull(state.queue)) return { ok: false, reason: { code: 'queueFull', size: MAX_QUEUE }, quote };
  return { ok: true, quote };
}

function validatePlaceTerrain(state: IslandState, cmd: { q: number; r: number; terrain: TerrainId }): Verdict {
  // S0.1: queued work of a constant length, no resource cost; the cell is checked against the
  // projected island (a queued place occupies its cell and counts toward adjacency and the cap).
  const quote: Quote = { cost: zeroVec(), refund: zeroVec(), durationMs: PLACE_DURATION_MS, building: null, level: 0 };
  const core = placeReason(project(state).tiles, cmd.q, cmd.r);
  if (core) return { ok: false, reason: core, quote };
  if (state.pieces[cmd.terrain] <= 0) {
    return { ok: false, reason: { code: 'noPiece', terrain: cmd.terrain }, quote };
  }
  if (isQueueFull(state.queue)) return { ok: false, reason: { code: 'queueFull', size: MAX_QUEUE }, quote };
  return { ok: true, quote };
}

function validateRemoveTerrain(state: IslandState, cmd: { q: number; r: number }): Verdict {
  const key = hexKey(cmd.q, cmd.r);
  const quote: Quote = { cost: zeroVec(), refund: zeroVec(), durationMs: 0, building: null, level: 0 };
  const tile = state.tiles[key];
  if (!tile) return { ok: false, reason: { code: 'needsTerrain' }, quote };
  if (tile.building) return { ok: false, reason: { code: 'occupied' }, quote };
  if (tile.seed) return { ok: false, reason: { code: 'seedLocked' }, quote };

  const afterTiles = { ...state.tiles };
  delete afterTiles[key];
  if (!isConnected(afterTiles)) return { ok: false, reason: { code: 'wouldSplit' }, quote };
  // S0.2: removal returns the piece, which would lift storage past the cap.
  if (storedPieces(state) >= PIECE_CAP) return { ok: false, reason: { code: 'piecesFull', cap: PIECE_CAP }, quote };
  if (!replayOk({ ...state, tiles: afterTiles })) return { ok: false, reason: { code: 'busy' }, quote };
  return { ok: true, quote };
}

function validateCancel(state: IslandState, cmd: { itemId: number }): Verdict {
  const item = state.queue.find((i) => i.id === cmd.itemId);
  if (!item) return { ok: false, reason: { code: 'busy' }, quote: null };
  const quote: Quote = { cost: zeroVec(), refund: item.paid, durationMs: 0, building: item.kind === 'place' ? null : item.building, level: item.kind === 'place' ? 0 : item.level };
  const remaining = state.queue.filter((i) => i.id !== cmd.itemId);
  if (!replayOk({ ...state, queue: remaining })) return { ok: false, reason: { code: 'busy' }, quote };
  return { ok: true, quote };
}

export const validate: ValidateFn = (state: IslandState, cmd: Command): Verdict => {
  switch (cmd.kind) {
    case 'build':
      return validateBuild(state, cmd);
    case 'upgrade':
      return validateUpgrade(state, cmd);
    case 'demolish':
      return validateDemolish(state, cmd);
    case 'placeTerrain':
      return validatePlaceTerrain(state, cmd);
    case 'removeTerrain':
      return validateRemoveTerrain(state, cmd);
    case 'cancel':
      return validateCancel(state, cmd);
  }
};

// ─────────────────────────────────────────────────────────────── apply

export const apply: ApplyFn = (state: IslandState, cmd: Command, now: GameMs): IslandState => {
  if (state.time !== now) throw new Error('apply: state.time !== now');
  const verdict = validate(state, cmd);
  if (!verdict.ok) throw new Error(`apply: invalid command (${verdict.reason.code})`);

  switch (cmd.kind) {
    case 'build': {
      const cost = costAt(cmd.building, 1);
      const treasury = payCost(state.treasury, cost);
      const item: QueueItem = {
        id: state.nextItemId,
        kind: 'build',
        q: cmd.q,
        r: cmd.r,
        building: cmd.building,
        level: 1,
        paid: cost,
        durationMs: durationMs(cmd.building, 1),
        startedAt: state.queue.length === 0 ? now : null,
      };
      return pushItem({ ...state, treasury, nextItemId: state.nextItemId + 1 }, item);
    }
    case 'upgrade': {
      const key = hexKey(cmd.q, cmd.r);
      const building = project(state).tiles[key].building!;
      const targetLevel = building.level + 1;
      const cost = costAt(building.id, targetLevel);
      const treasury = payCost(state.treasury, cost);
      const item: QueueItem = {
        id: state.nextItemId,
        kind: 'upgrade',
        q: cmd.q,
        r: cmd.r,
        building: building.id,
        level: targetLevel,
        paid: cost,
        durationMs: durationMs(building.id, targetLevel),
        startedAt: state.queue.length === 0 ? now : null,
      };
      return pushItem({ ...state, treasury, nextItemId: state.nextItemId + 1 }, item);
    }
    case 'demolish': {
      const key = hexKey(cmd.q, cmd.r);
      const building = project(state).tiles[key].building!;
      const item: QueueItem = {
        id: state.nextItemId,
        kind: 'demolish',
        q: cmd.q,
        r: cmd.r,
        building: building.id,
        level: building.level,
        paid: zeroVec(),
        durationMs: demolishMs(building.id, building.level),
        startedAt: state.queue.length === 0 ? now : null,
      };
      return pushItem({ ...state, nextItemId: state.nextItemId + 1 }, item);
    }
    case 'placeTerrain': {
      // The piece is reserved now (taken from `pieces`); the tile appears when the item completes.
      const pieces = { ...state.pieces, [cmd.terrain]: state.pieces[cmd.terrain] - 1 };
      const item: QueueItem = {
        id: state.nextItemId,
        kind: 'place',
        q: cmd.q,
        r: cmd.r,
        terrain: cmd.terrain,
        paid: zeroVec(),
        durationMs: PLACE_DURATION_MS,
        startedAt: state.queue.length === 0 ? now : null,
      };
      return pushItem({ ...state, pieces, nextItemId: state.nextItemId + 1 }, item);
    }
    case 'removeTerrain': {
      const key = hexKey(cmd.q, cmd.r);
      const tile = state.tiles[key];
      const tiles = { ...state.tiles };
      delete tiles[key];
      const pieces = { ...state.pieces, [tile.terrain]: state.pieces[tile.terrain] + 1 };
      return { ...state, tiles, pieces };
    }
    case 'cancel':
      return cancelQueueItem(state, cmd.itemId, now);
  }
};
