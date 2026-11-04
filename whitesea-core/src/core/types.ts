/**
 * types.ts — THE INTERFACE CONTRACT (ONESHOT-island-webgl.md §5.1 step 3).
 *
 * FROZEN once W0 is pushed. Only the orchestrator changes it, never while a relay
 * task is in flight, and every change is logged in web/PLAN.md "Contract changes".
 * Implementers: build against this file; if it is wrong, stop and report — do not edit it.
 *
 * Pure TS. No three, no DOM, no Date.now(), no Math.random().
 *
 * Units, pinned here because every lane depends on them:
 *  - Game time is an INTEGER number of MILLISECONDS (`GameMs`). Durations derived from §3.4
 *    seconds are `round(seconds) * 1000`. Integer time makes `advance` exactly associative.
 *  - Resources and population are FIXED-POINT integers (`Fixed`): 1 whole unit = RES_SCALE.
 *    A rate of r per game-hour accrues exactly r fixed units per game-millisecond
 *    (3_600_000 ms per hour), so accrual is integer arithmetic with no rounding anywhere.
 *    Display whole units with `Math.floor(x / RES_SCALE)`.
 *  - Rates (`perHour`) are whole units per game-hour (every §3.3 formula is integer).
 */

// ─────────────────────────────────────────────────────────────── units

/** Integer game-clock milliseconds. */
export type GameMs = number;
/** Fixed-point resource/population amount; 1 whole unit = RES_SCALE. */
export type Fixed = number;
/** 1 whole resource = 3 600 000 fixed units, so r/h accrues r units per ms. */
export const RES_SCALE = 3_600_000;
export const MS_PER_HOUR = 3_600_000;

// ─────────────────────────────────────────────────────────────── ids (§3.2)

export type TerrainId = 'land' | 'mountain';
export const TERRAIN_IDS: readonly TerrainId[] = ['land', 'mountain'];

export type Resource = 'wood' | 'food' | 'stone' | 'iron';
export const RESOURCES: readonly Resource[] = ['wood', 'food', 'stone', 'iron'];

export type Role = 'city' | 'field' | 'producer' | 'booster';

export type BuildingId =
  | 'mainhouse' | 'villagecentre' | 'warehouse' | 'house'
  | 'forest' | 'wheatfield' | 'quarry' | 'irondeposit'
  | 'lumberjack' | 'farm' | 'stonemason' | 'oremine'
  | 'sawmill' | 'bakery' | 'stonegrindery' | 'ironsmelter';

/** Catalog order = §3.2 table order. */
export const BUILDING_IDS: readonly BuildingId[] = [
  'mainhouse', 'villagecentre', 'warehouse', 'house',
  'forest', 'wheatfield', 'quarry', 'irondeposit',
  'lumberjack', 'farm', 'stonemason', 'oremine',
  'sawmill', 'bakery', 'stonegrindery', 'ironsmelter',
];

/** One amount per resource. Whole units unless the field says Fixed. */
export type ResourceVec = Record<Resource, number>;

// ─────────────────────────────────────────────────────────────── hex (§3.1)

/** Flat-top axial coordinates on the XZ plane. */
export interface Hex { q: number; r: number }
/** `${q},${r}` — the only key format. Build with hexKey(), parse with parseKey() (core/hex.ts). */
export type HexKey = string;

// ─────────────────────────────────────────────────────────────── catalog (§3.2, §3.4, §3.5)

/** Per-resource cost curve parameters: cost_r(L) = n ≥ 1 ? floor(base·n·(58+42n)/100) : 0, n = L − from. */
export interface CostParam { base: number; from: number }

export type Unlock =
  | { kind: 'seed' }                                          // mainhouse: never built
  | { kind: 'townHall'; level: number }                       // §3.5 unlock table
  | { kind: 'building'; building: BuildingId; level: number }; // booster high-water gate

export interface BuildingDef {
  id: BuildingId;
  role: Role;
  /** The resource a field/producer/booster belongs to; null for city buildings. */
  resource: Resource | null;
  /** Every building is single-terrain. */
  terrain: TerrainId;
  /** Placeholder English display name. Themed names are a display layer (§3.2). */
  displayName: string;
  maxLevel: number;
  /** null = never charged in that resource. */
  cost: Record<Resource, CostParam | null>;
  unlock: Unlock;
}

// ─────────────────────────────────────────────────────────────── island state

export interface PlacedBuilding {
  id: BuildingId;
  /** Completed level, ≥ 1. Fields are always 1. Invested cost is derived from (id, level). */
  level: number;
}

export interface Tile {
  q: number;
  r: number;
  terrain: TerrainId;
  /** Seed terrain (the starting 7-hex island) is locked: never removable. */
  seed: boolean;
  /** Only COMPLETED buildings live here; pending work lives in the queue. */
  building: PlacedBuilding | null;
}

/** S0.1 (Open Sea PLAN): `place` = a timed terrain placement (DECISIONS 2026-09-25 #5). */
export type QueueKind = 'build' | 'upgrade' | 'demolish' | 'place';

interface QueueItemBase {
  /** Unique, monotonically increasing (IslandState.nextItemId). */
  id: number;
  q: number;
  r: number;
  /** Paid in full at enqueue (whole units); refunded 100% on cancel. Zero for demolish and place. */
  paid: ResourceVec;
  /** Total duration in game ms. build/upgrade: round(seconds(level))·1000; demolish: 750·round(seconds(level)); place: PLACE_DURATION_MS. */
  durationMs: GameMs;
  /** Game time the item became active; null while waiting. Only queue[0] may be active. */
  startedAt: GameMs | null;
}

/** Work on a building. */
export interface WorkItem extends QueueItemBase {
  kind: 'build' | 'upgrade' | 'demolish';
  building: BuildingId;
  /** build: 1 · upgrade: the level being reached · demolish: the level being demolished. */
  level: number;
}

/**
 * S0.1: a terrain piece being placed. The piece is taken from `pieces` at enqueue (reserved) and
 * returned on cancel; the cell counts as occupied in the projected state; the tile appears when
 * the item completes.
 */
export interface PlaceItem extends QueueItemBase {
  kind: 'place';
  terrain: TerrainId;
  /**
   * S3a: game time the item's timer was paused because the island is underway (placement only
   * runs while holding). Absent/undefined = running. On resume, startedAt shifts forward by
   * (resume − pausedAt) and pausedAt is cleared, so progress = (pausedAt ?? now) − startedAt.
   */
  pausedAt?: GameMs;
}

export type QueueItem = WorkItem | PlaceItem;

/** §3.13 — the mode seam. Only 'island' is implemented. */
export type GameMode = 'island' | 'openSkies';

export interface IslandState {
  /** Game clock: integer ms since the island was founded. */
  time: GameMs;
  mode: GameMode;
  /** Keyed by hexKey. Terrain tiles only; empty cells are absent. */
  tiles: Record<HexKey, Tile>;
  /** Fixed-point, per resource. Invariant: 0 ≤ treasury[r] ≤ storage cap · RES_SCALE. */
  treasury: Record<Resource, Fixed>;
  /** Fixed-point. Invariant: 0 ≤ population ≤ population cap · RES_SCALE. Nothing spends it yet (§3.6). */
  population: Fixed;
  /** Terrain pieces available to place (§3.6 PieceSource). */
  pieces: Record<TerrainId, number>;
  /** FIFO; queue[0] is the active slot when its startedAt != null. Max length = BUILD_SLOTS + QUEUE_SIZE. */
  queue: QueueItem[];
  /** Highest level each building id has EVER reached on this island (§3.5 booster gate, piece grants). */
  highWater: Partial<Record<BuildingId, number>>;
  nextItemId: number;
}

// ─────────────────────────────────────────────────────────────── layout (planner, MapID, fixtures)

/** One cell of a layout. Bare terrain: building null, level 0. Fields: level 1. */
export interface LayoutRecord {
  q: number;
  r: number;
  terrain: TerrainId;
  building: BuildingId | null;
  level: number;
}
export type Layout = LayoutRecord[];

// ─────────────────────────────────────────────────────────────── commands & verdicts (§3.7, §4)

export type Command =
  | { kind: 'placeTerrain'; q: number; r: number; terrain: TerrainId }   // queued (S0.1: PLACE_DURATION_MS)
  | { kind: 'removeTerrain'; q: number; r: number }                      // instant; bare, player-placed only
  | { kind: 'build'; q: number; r: number; building: BuildingId }        // queued
  | { kind: 'upgrade'; q: number; r: number }                            // queued; prices the level after queued ones
  | { kind: 'demolish'; q: number; r: number }                           // queued; building only
  | { kind: 'cancel'; itemId: number };                                  // instant; refunds 100% of `paid`

export type Reason =
  | { code: 'lockedByTownHall'; need: number }
  | { code: 'lockedByBuilding'; building: BuildingId; level: number }
  | { code: 'unaffordable'; shortfall: ResourceVec }
  | { code: 'exceedsStorage'; resource: Resource; cost: number; cap: number }
  | { code: 'wrongTerrain'; need: TerrainId }
  | { code: 'needsTerrain' }
  | { code: 'occupied' }
  | { code: 'outsideTerritory' }
  | { code: 'islandFull'; cap: number }
  | { code: 'noPiece'; terrain: TerrainId }
  | { code: 'notAdjacent' }
  | { code: 'maxLevel'; max: number }
  | { code: 'queueFull'; size: number }
  | { code: 'busy' }
  | { code: 'wouldSplit' }
  | { code: 'seedLocked' }
  | { code: 'townHallPermanent' }
  | { code: 'wouldStrand' }
  /** W0 addition to §4's list: upgrade/demolish on a tile whose projected state has no building. */
  | { code: 'noBuilding' }
  /** S0.2 (Open Sea PLAN): removing bare terrain returns its piece, and storage is already at PIECE_CAP. */
  | { code: 'piecesFull'; cap: number }
  /** S3a: setCourse to (within MOVE_EPSILON_U of) where the island already is / its current target. */
  | { code: 'alreadyThere' }
  /** S3a: stop while the island is holding. */
  | { code: 'notUnderway' };

export type ReasonCode = Reason['code'];

/** What a command would cost/refund/take — rendered by the plaque even when the verdict is a refusal. */
export interface Quote {
  /** Whole units paid now (build/upgrade); zero otherwise. */
  cost: ResourceVec;
  /** Whole units returned (demolish: floor(50% invested); cancel: 100% of paid); zero otherwise. */
  refund: ResourceVec;
  /** Game ms the work takes; 0 for instant commands. */
  durationMs: GameMs;
  /** The building acted on, if any. */
  building: BuildingId | null;
  /** build: 1 · upgrade: projected level + 1 · demolish: projected level · else 0. */
  level: number;
}

export type Verdict =
  | { ok: true; quote: Quote }
  | { ok: false; reason: Reason; quote: Quote | null };

// ─────────────────────────────────────────────────────────────── reports (§3.3, §3.6)

export interface BoosterReach { q: number; r: number; building: BuildingId; level: number; pct: number }

export interface ProducerDetail {
  q: number;
  r: number;
  building: BuildingId;
  resource: Resource;
  level: number;
  radius: number;
  /** 1 + 3r(r+1). */
  scanned: number;
  eligible: number;
  worked: number;
  baseYield: number;
  boostPct: number;
  yieldPerField: number;
  production: number;
  /** Every cell within radius (excluding the producer's own cell), for the X-ray. */
  reach: Hex[];
  /** Matching fields in reach. */
  eligibleFields: Hex[];
  /** Display-only worked set: nearest-first, ties by (q, r). Production never depends on it. */
  workedFields: Hex[];
  /** Same-resource boosters whose own reach covers this producer. */
  boosters: BoosterReach[];
}

/** Per-tile contribution, for the Info view on fields and boosters. */
export interface TileContribution {
  /** Producers (hexKeys) that count this field as eligible, or that this booster boosts. */
  feeds: HexKey[];
  /** Producers (hexKeys) that list this field in their display-worked set. Empty for boosters. */
  workedBy: HexKey[];
}

export interface ProductionReport {
  /** Whole units per game-hour, including the town hall's unconditional +5 wood / +5 food. */
  perHour: ResourceVec;
  /** Keyed by the producer's hexKey. */
  producers: Record<HexKey, ProducerDetail>;
  /** Keyed by the field's/booster's hexKey. */
  contributions: Record<HexKey, TileContribution>;
}

export interface CapacityReport {
  /** Whole units, same cap for every resource: 500 + Σ warehouses 25·L·(9+L). */
  storage: number;
  /** Whole units: 500 + 500·Σ house levels. */
  populationCap: number;
  /** Whole units per game-hour: 2 + #houses. */
  populationPerHour: number;
  /** Union of spheres radius min(L,4) around the TH and every VC. */
  territory: HexKey[];
  /** 20 · TH level. */
  islandCap: number;
  /** Terrain tiles on the island, seed included. */
  islandSize: number;
  townHallLevel: number;
  /** Highest village-centre level (0 if none). */
  villageCentreLevel: number;
}

// ─────────────────────────────────────────────────────────────── the clock (§3.8)

export type SimEvent =
  | { kind: 'started'; at: GameMs; item: QueueItem }
  | { kind: 'completed'; at: GameMs; item: QueueItem }
  | { kind: 'storageFull'; at: GameMs; resource: Resource }
  | { kind: 'populationFull'; at: GameMs }
  | { kind: 'piecesGranted'; at: GameMs; pieces: Record<TerrainId, number>; townHallLevel: number }
  /** S0.2: the part of a grant that did not fit under PIECE_CAP (truncated, never stored). */
  | { kind: 'piecesLost'; at: GameMs; pieces: Record<TerrainId, number> };

export interface AdvanceResult { state: IslandState; events: SimEvent[] }

// ─────────────────────────────────────────────────────────────── save (§3.8)

export const SAVE_SCHEMA_VERSION = 1;

export interface SaveFileV1 {
  version: 1;
  /** Wall-clock epoch ms at save time, supplied by the game layer (core never reads a clock). */
  savedAt: number;
  state: IslandState;
}
export type SaveFile = SaveFileV1;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────── §3.13 Open Skies seams

/** Where terrain pieces come from. Today: a grant table (config). Open Skies fills it later. */
export interface PieceSource {
  initial(): Record<TerrainId, number>;
  /** Pieces granted when the town hall COMPLETES `level` (called once per level, ≥ 2). */
  onTownHallLevel(level: number): Record<TerrainId, number>;
}

/** Game-clock abstraction. Pure: the caller feeds real deltas in; core never reads a clock. */
export interface GameClock {
  /** Game seconds per real second: 1 in play, 1–3600 on the dev slider. */
  timescale: number;
  /** Convert a real delta (ms, may be fractional) into integer game ms, carrying the remainder. */
  tick(realDtMs: number): GameMs;
  /** Offline catch-up: game ms owed for a wall-clock gap. ALWAYS 1×, whatever the slider says. */
  catchUp(wallElapsedMs: number): GameMs;
}

/** The whole island hangs under one movable root (render implements it with one THREE.Group). */
export interface MovableRoot {
  setWorldOffset(x: number, y: number, z: number): void;
  /** Underlight bounce strength: island .22, openSkies .58 — one lerp, not a second rig. */
  setUnderlight(bounce: number): void;
}

/**
 * Open Sea S1 — one camera profile per screen (PLAN-open-sea-webgl §3.1, S1.1). Plain numbers so
 * config.ts can hold the values; the renderer's rig consumes them.
 */
export interface RigProfile {
  /**
   * Downward pitch from horizontal (degrees) by camera height — S1.6 "tilt as you zoom". Knots in
   * ascending y; between two knots the pitch is interpolated in log height; outside them it holds
   * the end knot. One knot = a fixed pitch. Every knot keeps deg ≥ FOV/2 + 10 (no sky on screen,
   * art-direction §4.3 #2) — pinned by a test.
   */
  pitch: readonly { y: number; deg: number }[];
  /** Dolly range: camera height above the deck top (world units). */
  minY: number;
  maxY: number;
  /** Height on first entry to the screen. */
  startY: number;
  /** 'island' = the tiles' bounds (live, from setSnapshot); a rect = fixed world bounds. */
  panBounds: 'island' | { minX: number; maxX: number; minZ: number; maxZ: number };
  /** How far the focus may stray past panBounds (world units). */
  panMargin: number;
  /** Clip planes at height y: max(min, perY · y). */
  near: { min: number; perY: number };
  far: { min: number; perY: number };
}

// ─────────────────────────────────────────────────────────────── S3a: the island moves (PLAN-open-sea §3.3, specs/S3a.md)

/** A point on the world's island-altitude plane (world units; x east, z south — three's XZ). */
export interface Vec2 { x: number; z: number }

/**
 * The island's movement as a timestamped path, never per-tick positions: positionAt(mover, t) is
 * pure, so offline catch-up never steps positions (§3.3).
 * - holding: `pos` is where it is; `path` and `legs` are empty.
 * - underway: `path` = [from, …, to] (S3a: exactly [from, to]; S3's A* adds corners), `legs[i]`
 *   covers path[i] → path[i+1] with integer game-ms times, legs[0].tStart === departAt; `pos` is
 *   path[0]. Speed is fixed at departure (a tile removed mid-voyage doesn't re-time the course).
 */
export interface Mover {
  state: 'holding' | 'underway';
  pos: Vec2;
  path: Vec2[];
  departAt: GameMs;
  legs: { tStart: GameMs; tEnd: GameMs }[];
}

export interface SeaState {
  /** 0 until S2's generator exists; the world itself is never saved (§3.3). */
  worldSeed: number;
  worldVersion: number;
  island: Mover;
  nextId: number;
}

/** The whole game: the island (unchanged shape) and the sea. Both share `island.time`'s clock. */
export interface GameState { island: IslandState; sea: SeaState }

export type SeaCommand =
  | { kind: 'setCourse'; target: Vec2 }   // clamped into the travel area; a redirect starts at positionAt(now)
  | { kind: 'stop' };                     // holds where it is now

export type SeaEvent =
  | { kind: 'departed'; at: GameMs; from: Vec2; to: Vec2; eta: GameMs }
  | { kind: 'arrived'; at: GameMs; pos: Vec2 }
  | { kind: 'stopped'; at: GameMs; pos: Vec2 };

export type GameEvent = SimEvent | SeaEvent;

export interface AdvanceGameResult { state: GameState; events: GameEvent[] }

/** §3.6 — the skill-tree seam. Every formula reads it; today all identity (core/modifiers.ts). */
export interface Modifiers {
  /** × island speed. */
  islandSpeed: number;
  /** Percent of production kept while underway (integer, 0–100; UNDERWAY_PRODUCTION_PCT). */
  underwayProductionPct: number;
}

/** What the island's clock needs to know about the sea for one segment (clock.ts). */
export interface IslandConditions {
  underway: boolean;
  modifiers: Modifiers;
}

/** S3a save: key GAME_SAVE_KEY; `version` (not `v`) so save.ts's migrate loop reads it. */
export interface SaveFileV2 {
  version: 2;
  savedAt: number;
  state: GameState;
}

// ─────────────────────────────────────────────────────────────── core function signatures
// Each module implements exactly these (plus private helpers). Tests import the modules.

/** core/sim.ts */
export type ValidateFn = (state: IslandState, cmd: Command) => Verdict;
/** core/sim.ts — precondition: state.time === now (the store advances first). Throws on an invalid cmd. */
export type ApplyFn = (state: IslandState, cmd: Command, now: GameMs) => IslandState;
/** core/sim.ts — the state as if every queued item had completed, in order (layout, highWater, pieces). */
export type ProjectFn = (state: IslandState) => IslandState;
/**
 * core/clock.ts — event-stepped; advance(s, a+b) ≡ advance(advance(s, a).state, b). dt ≥ 0 integer.
 * S3a: `cond` (default: holding, identity modifiers) holds for the whole call — core/game.ts splits
 * at every sea event. Underway: resource rates are floor(perHour · underwayProductionPct / 100)
 * (integer, so associativity holds); population growth is unchanged; a `place` head's timer is paused.
 */
export type AdvanceFn = (state: IslandState, dtMs: GameMs, cond?: IslandConditions) => AdvanceResult;
/** core/economy.ts */
export type ProductionFn = (tiles: Record<HexKey, Tile>) => ProductionReport;
/** core/territory.ts */
export type CapacityFn = (tiles: Record<HexKey, Tile>) => CapacityReport;
/** core/mapid.ts */
export type EncodeMapIdFn = (layout: Layout) => string;
export type DecodeMapIdFn = (code: string) => Result<Layout>;
/** core/save.ts */
export type SerializeFn = (state: IslandState, savedAt: number) => string;
export type DeserializeFn = (json: string) => Result<SaveFile>;
/** core/save.ts (S3a) — the v2 save. Deserialize migrates a v1 file (island holding at SPAWN_POS). */
export type SerializeGameFn = (state: GameState, savedAt: number) => string;
export type DeserializeGameFn = (json: string) => Result<SaveFileV2>;

/** core/world/speed.ts (S3a) — world units per game-hour for an island of `tiles` terrain tiles. */
export type IslandSpeedFn = (tiles: number, mods: Modifiers) => number;
/** core/world/mover.ts (S3a) — pure; t clamped into [departAt, last tEnd]. */
export type PositionAtFn = (mover: Mover, t: GameMs) => Vec2;
/** core/game.ts (S3a) — event-stepped over island AND sea events; associative like advance. */
export type AdvanceGameFn = (state: GameState, dtMs: GameMs) => AdvanceGameResult;
/** core/game.ts (S3a) */
export type ValidateSeaFn = (state: GameState, cmd: SeaCommand) => Verdict;
/** core/game.ts (S3a) — precondition: state.island.time === now. Throws on an invalid cmd. */
export type ApplySeaFn = (state: GameState, cmd: SeaCommand, now: GameMs) => GameState;
