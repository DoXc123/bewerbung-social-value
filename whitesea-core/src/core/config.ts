/**
 * config.ts — every PROVISIONAL number (ONESHOT §6). §3 numbers are NOT here: they live in
 * the modules that implement them. The user may overrule any value below.
 * Pure TS: no three, no DOM, no clock, no randomness.
 */
import type { GameMode, PieceSource, Resource, RigProfile, TerrainId } from './types';

// ─────────────────────────────── queue & verbs

/** Active build slots. */
export const BUILD_SLOTS = 1; // provisional — ONESHOT §6
/** Waiting items behind the active slot. Max queue length = BUILD_SLOTS + QUEUE_SIZE. */
export const QUEUE_SIZE = 3; // provisional — ONESHOT §6
export const MAX_QUEUE = BUILD_SLOTS + QUEUE_SIZE; // provisional — ONESHOT §6

/** Demolish refund share of TOTAL invested (lock G). Floor per resource. */
export const DEMOLISH_REFUND_PCT = 50; // provisional — ONESHOT §6 (lock G, §3.7)
/** Demolish time as a share of the current level's build time. */
export const DEMOLISH_TIME_PCT = 75; // provisional — ONESHOT §6 (§3.7)
/** Cancel refunds 100% of what was paid at enqueue. */
export const CANCEL_REFUND_PCT = 100; // provisional — ONESHOT §6

// ─────────────────────────────── the starting island

/** Town hall at the origin, level 1; the seed is it plus its 6 neighbours, all land, all locked. */
export const SEED_CENTRE = { q: 0, r: 0 } as const; // provisional — ONESHOT §6
export const SEED_RADIUS = 1; // provisional — ONESHOT §6
export const SEED_TERRAIN: TerrainId = 'land'; // provisional — ONESHOT §6
export const SEED_TOWN_HALL_LEVEL = 1; // provisional — ONESHOT §6

/** Full base storage in wood+food, nothing else — without it the first forest+lumberjack take 12 game-hours. */
export const START_TREASURY: Record<Resource, number> = { wood: 500, food: 500, stone: 0, iron: 0 }; // provisional — ONESHOT §6
export const START_POPULATION = 0; // provisional — ONESHOT §6

// ─────────────────────────────── pieces (the PieceSource placeholder)

export const PIECES_INITIAL: Record<TerrainId, number> = { land: 10, mountain: 10 }; // provisional — ONESHOT §6
export const PIECES_PER_TH_LEVEL: Record<TerrainId, number> = { land: 5, mountain: 3 }; // provisional — ONESHOT §6

/** S0.1: placing a terrain piece is queued work of this constant length, whatever the island's size. */
export const PLACE_DURATION_MS = 120_000; // provisional — PLAN-open-sea §6 (DECISIONS 2026-09-25 #5)
/** S0.2: stored pieces, both terrains together, never exceed this; a grant past it is truncated. */
export const PIECE_CAP = 20; // provisional — PLAN-open-sea §6 (DECISIONS 2026-09-25 #7)

/** Today's PieceSource: a grant table. Open Skies replaces it (§3.13). */
export const grantTablePieceSource: PieceSource = {
  initial: () => ({ ...PIECES_INITIAL }),
  onTownHallLevel: () => ({ ...PIECES_PER_TH_LEVEL }),
};

// ─────────────────────────────── roster rules

/** City buildings (mainhouse, villagecentre, warehouse, house) are land-only. */
export const CITY_TERRAIN: TerrainId = 'land'; // provisional — ONESHOT §6
/** Research is not built, so every weight in the time formula is 1. */
export const RESEARCH_DISCOUNT_PCT = 0; // provisional — ONESHOT §6
/** Multiple village centres are allowed; the TH gate reads the highest VC level. */
export const MAX_VILLAGE_CENTRES = Infinity; // provisional — ONESHOT §6

// ─────────────────────────────── clock

/** Dev-only timescale slider range (game seconds per real second). */
export const TIMESCALE_MIN = 1; // provisional — ONESHOT §6
export const TIMESCALE_MAX = 3600; // provisional — ONESHOT §6
/** Offline catch-up always runs at 1×, whatever the slider says. */
export const CATCHUP_TIMESCALE = 1; // provisional — ONESHOT §6
/** Slow autosave timer (real ms), on top of every-command + visibilitychange/pagehide saves. */
export const AUTOSAVE_INTERVAL_MS = 15_000; // provisional — ONESHOT §6
/** localStorage key for the JSON save. */
export const SAVE_KEY = 'whitesea.island.v1'; // provisional — ONESHOT §6
/** localStorage key for the planner sandbox layout (W8). */
export const PLANNER_KEY = 'whitesea.planner.v1'; // provisional — ONESHOT §6

// ─────────────────────────────── modes & light (§3.13)

/** Underlight bounce strength per mode: position 2 (.22) in island mode, 3 (.58) in open skies. */
export const UNDERLIGHT_BY_MODE: Record<GameMode, number> = { island: 0.22, openSkies: 0.58 }; // provisional — ONESHOT §6

// ─────────────────────────────── render & chrome

/** The collar tier steps when a building REACHES these levels (where reach and builders also step). */
export const COLLAR_TIER_LEVELS = [7, 19] as const; // provisional — ONESHOT §6 (bible §9.2 says 6/18 — see PLAN.md)
/** City buildings carry no resource hue: the lighting board's building tokens. */
export const CITY_ROOF = '#B6BCC4'; // provisional — ONESHOT §6
export const CITY_WALL = '#878D97'; // provisional — ONESHOT §6
/** Instanced rim wisps; measured in W9. */
export const RIM_PARTICLE_CAP = 1500; // provisional — ONESHOT §6
/** Wheel disc diameter clamp, CSS px (40 = skin-lock §4 rule 5 minimum read size). */
export const WHEEL_DISC_MIN_PX = 40; // provisional — ONESHOT §6
export const WHEEL_DISC_MAX_PX = 72; // provisional — ONESHOT §6

// Camera — the Unity scene's values (§3.10), provisional.
/** Hex circumradius in world units. */
export const HEX_SIZE = 1; // provisional — ONESHOT §6 (Unity value)
/** Deck slab thickness in world units. */
export const TILE_HEIGHT = 0.3; // provisional — ONESHOT §6 (Unity value)
/** Vertical field of view, degrees. */
export const CAMERA_FOV_DEG = 60; // provisional — ONESHOT §6 (Unity value)
/** Camera height at first load. */
export const CAMERA_START_Y = 9; // provisional — ONESHOT §6 (Unity value)
/** Pan clamp: the focus point may stray this many world units past the island's extent. */
export const PAN_MARGIN = 4; // provisional — ONESHOT §6

// ─────────────────────────────── Open Sea shell (PLAN-open-sea-webgl §6, phase S1)

/** Island view: today's rig exactly (§3.10). */
export const RIG_ISLAND: RigProfile = {
  // S1.6: low and cinematic up close, today's 50° at the resting height (y 9), map-like far out.
  pitch: [{ y: 3, deg: 40 }, { y: 9, deg: 50 }, { y: 40, deg: 58 }], minY: 3, maxY: 40, startY: CAMERA_START_Y, panBounds: 'island', panMargin: PAN_MARGIN,
  near: { min: 0.1, perY: 0 }, far: { min: 2000, perY: 0 },
}; // provisional — PLAN-open-sea §6
/** Sea view: high above the world. Bounds/far sized to the S1 placeholder floor; S2.3 widens them. */
export const RIG_SEA: RigProfile = {
  pitch: [{ y: 40, deg: 60 }], minY: 40, maxY: 600, startY: 300,
  panBounds: { minX: -150, maxX: 150, minZ: -150, maxZ: 150 }, panMargin: 0, // S3a: the travel disc + a margin
  near: { min: 0.5, perY: 0.02 }, far: { min: 2000, perY: 4 },
}; // provisional — PLAN-open-sea §6
/** Island ↔ Sea camera flight (ease-in-out) and the chrome crossfade. */
export const FLIGHT_MS = 1_200; // provisional — PLAN-open-sea §6
export const CHROME_FADE_MS = 200; // provisional — PLAN-open-sea §6
/** Reduce motion: the flight becomes a fade of this length (the camera cuts at its midpoint). */
export const REDUCED_FLIGHT_MS = 150; // provisional — PLAN-open-sea §6
/** Overscroll: this many zoom-out steps past the island clamp within the window opens Sea. */
export const OVERSCROLL_STEPS = 3; // provisional — PLAN-open-sea §6
export const OVERSCROLL_WINDOW_MS = 600; // provisional — PLAN-open-sea §6
/** Per-viewer settings (separate from the save). */
export const SETTINGS_KEY = 'whitesea.settings.v1'; // provisional — PLAN-open-sea §6
/** Graphics presets: pixel-ratio cap, rim-wisp scale, floor LOD (S2.3 reads the LOD). */
export const GRAPHICS_PRESETS = {
  low: { pixelRatioCap: 1, wispScale: 0.5, shadowMapSize: 0 },
  medium: { pixelRatioCap: 1.5, wispScale: 0.75, shadowMapSize: 1024 },
  high: { pixelRatioCap: 2, wispScale: 1, shadowMapSize: 2048 },
} as const; // provisional — PLAN-open-sea §6
/** Interface scale range (Options), step 0.05. */
export const UI_SCALE_MIN = 0.8; // provisional — PLAN-open-sea §6
export const UI_SCALE_MAX = 1.25; // provisional — PLAN-open-sea §6
/** Camera zoom/pan speed multipliers (Options). */
export const CAMERA_SPEED_MIN = 0.5; // provisional — PLAN-open-sea §6
export const CAMERA_SPEED_MAX = 2; // provisional — PLAN-open-sea §6
/** The world seed until S2's generator reads it (dev Options can change it). */
export const WORLD_SEED_DEFAULT = 1; // provisional — PLAN-open-sea §6

// ─────────────────────────────── Open Sea S3a — the island moves (PLAN-open-sea §4 S3, specs/S3a.md)

/** v = V_BASE · max(SPEED_FLOOR, (SPEED_REF_TILES / max(tiles, SPEED_REF_TILES))^SPEED_ALPHA) · mods. */
export const V_BASE_U_PER_H = 72; // provisional — PLAN-open-sea §6 (6 sea cells/h × 12 u)
export const SPEED_REF_TILES = 20; // provisional — PLAN-open-sea §6
export const SPEED_ALPHA = 0.25; // provisional — PLAN-open-sea §6
export const SPEED_FLOOR = 0.4; // provisional — PLAN-open-sea §6
/** Percent of resource production kept while underway (the user, 2026-09-25). */
export const UNDERWAY_PRODUCTION_PCT = 75; // provisional — PLAN-open-sea §6
/** Until S2's world: the island may travel anywhere within this radius of SPAWN_POS. */
// 240 → 120 (S3a.3): the S1-tuned floor mesh (±950, dense only near the origin) shows its
// dissolved edge as a wall at y 600 once the Sea pans much past ±150; S2.3's world floor lifts it.
export const TRAVEL_RADIUS_U = 120; // provisional — plans/ws-depth-nav §S3a
/** Where a new island (and a migrated v1 save) holds. */
export const SPAWN_POS = { x: 0, z: 0 } as const; // provisional — plans/ws-depth-nav §S3a
/** A course shorter than this is `alreadyThere`. */
export const MOVE_EPSILON_U = 0.5; // provisional — plans/ws-depth-nav §S3a
/** The v2 save (GameState). The v1 key (SAVE_KEY) is read once for migration, never deleted before v2 is written. */
export const GAME_SAVE_KEY = 'whitesea.game.v2'; // provisional — PLAN-open-sea §6

// Dev
export const DEV_PORT = 5188; // provisional — ONESHOT §6
export const SHOT_PORT = 5189; // provisional — ONESHOT §6
