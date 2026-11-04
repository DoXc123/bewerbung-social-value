/**
 * away.ts — the "while you were away" summary (W7-store, ONESHOT §3.8).
 *
 * Pure: folds the events of an offline catch-up and the before/after states into what the
 * away panel (ui/away.ts) lists. Completions during catch-up don't animate — they end up here.
 */
import { RES_SCALE, RESOURCES, TERRAIN_IDS } from '../core/types';
import type {
  BuildingId, GameEvent, GameMs, IslandState, QueueKind, Resource, ResourceVec, TerrainId, Vec2,
} from '../core/types';

export interface AwaySummary {
  /** Wall-clock gap caught up. */
  elapsedMs: number;
  /** Building work (build/upgrade/demolish) completed, in order. Placements are counted in `placed`. */
  completed: { kind: Exclude<QueueKind, 'place'>; building: BuildingId; level: number; q: number; r: number }[];
  /** Resources that hit the cap, in RESOURCES order, each once. */
  storageFull: Resource[];
  populationFull: boolean;
  /** Summed over every town-hall level completed. */
  piecesGranted: Record<TerrainId, number>;
  /** S0.2: summed over every grant truncated at PIECE_CAP — pieces that were never stored. */
  piecesLost: Record<TerrainId, number>;
  /** S0.1: terrain placements completed, per terrain. */
  placed: Record<TerrainId, number>;
  /** Whole units, after − before (may be 0 when capped). */
  gained: ResourceVec;
  /** S3a: the last arrival during the gap (null if none). */
  arrived: { at: GameMs; pos: Vec2 } | null;
  /** S3a: game ms spent underway during the gap. */
  underwayMs: number;
}

export function summarizeAway(
  before: IslandState,
  after: IslandState,
  events: GameEvent[],
  elapsedMs: number,
  /** S3a: the island was underway when the gap began (the events only carry the changes). */
  wasUnderway = false,
): AwaySummary {
  const completed: AwaySummary['completed'] = [];
  const full = new Set<Resource>();
  let populationFull = false;
  const piecesGranted = {} as Record<TerrainId, number>;
  const piecesLost = {} as Record<TerrainId, number>;
  const placed = {} as Record<TerrainId, number>;
  for (const t of TERRAIN_IDS) {
    piecesGranted[t] = 0;
    piecesLost[t] = 0;
    placed[t] = 0;
  }

  let arrived: AwaySummary['arrived'] = null;
  let underwayMs = 0;
  let underwaySince: GameMs | null = wasUnderway ? before.time : null;

  for (const e of events) {
    switch (e.kind) {
      case 'completed':
        if (e.item.kind === 'place') {
          placed[e.item.terrain]++;
          break;
        }
        completed.push({ kind: e.item.kind, building: e.item.building, level: e.item.level, q: e.item.q, r: e.item.r });
        break;
      case 'storageFull':
        full.add(e.resource);
        break;
      case 'populationFull':
        populationFull = true;
        break;
      case 'piecesGranted':
        for (const t of TERRAIN_IDS) piecesGranted[t] += e.pieces[t] ?? 0;
        break;
      case 'piecesLost':
        for (const t of TERRAIN_IDS) piecesLost[t] += e.pieces[t] ?? 0;
        break;
      case 'started':
        break;
      case 'departed':
        underwaySince ??= e.at;
        break;
      case 'arrived':
        arrived = { at: e.at, pos: e.pos };
        if (underwaySince !== null) underwayMs += Math.max(0, e.at - underwaySince);
        underwaySince = null;
        break;
      case 'stopped':
        if (underwaySince !== null) underwayMs += Math.max(0, e.at - underwaySince);
        underwaySince = null;
        break;
    }
  }

  if (underwaySince !== null) underwayMs += Math.max(0, after.time - underwaySince);

  const gained = {} as ResourceVec;
  for (const r of RESOURCES) {
    gained[r] = Math.floor(after.treasury[r] / RES_SCALE) - Math.floor(before.treasury[r] / RES_SCALE);
  }

  return {
    elapsedMs,
    completed,
    storageFull: RESOURCES.filter((r) => full.has(r)),
    populationFull,
    piecesGranted,
    piecesLost,
    placed,
    gained,
    arrived,
    underwayMs,
  };
}

