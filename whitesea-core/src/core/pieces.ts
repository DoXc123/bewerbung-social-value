/**
 * pieces.ts — terrain-piece storage (Open Sea S0.2, DECISIONS 2026-09-25 #7): stored pieces are
 * the ones in hand plus the ones reserved by queued `place` items, and a grant never lifts that
 * past PIECE_CAP — the overflow is truncated round-robin in TERRAIN_IDS order and reported lost.
 */
import { PIECE_CAP } from './config';
import { TERRAIN_IDS } from './types';
import type { IslandState, QueueItem, TerrainId } from './types';

function zeroPieces(): Record<TerrainId, number> {
  const out = {} as Record<TerrainId, number>;
  for (const t of TERRAIN_IDS) out[t] = 0;
  return out;
}

/** Pieces taken from `pieces` by queued `place` items (returned on cancel). */
export function reservedPieces(queue: readonly QueueItem[]): Record<TerrainId, number> {
  const out = zeroPieces();
  for (const item of queue) if (item.kind === 'place') out[item.terrain]++;
  return out;
}

/** Σ pieces in hand + Σ reserved — the number PIECE_CAP bounds. */
export function storedPieces(state: Pick<IslandState, 'pieces' | 'queue'>): number {
  const reserved = reservedPieces(state.queue);
  let total = 0;
  for (const t of TERRAIN_IDS) total += state.pieces[t] + reserved[t];
  return total;
}

/**
 * Split `grant` into what fits under PIECE_CAP given `stored` pieces already held, one piece per
 * terrain in TERRAIN_IDS order until the grant or the room runs out. A store already at or over
 * the cap (an old save) receives nothing.
 */
export function truncateGrant(
  stored: number,
  grant: Record<TerrainId, number>,
): { kept: Record<TerrainId, number>; lost: Record<TerrainId, number> } {
  const kept = zeroPieces();
  const left = zeroPieces();
  for (const t of TERRAIN_IDS) left[t] = Math.max(0, grant[t] ?? 0);
  let room = Math.max(0, PIECE_CAP - stored);
  let any = true;
  while (room > 0 && any) {
    any = false;
    for (const t of TERRAIN_IDS) {
      if (room === 0) break;
      if (left[t] === 0) continue;
      kept[t]++;
      left[t]--;
      room--;
      any = true;
    }
  }
  return { kept, lost: left };
}

export function anyPieces(p: Record<TerrainId, number>): boolean {
  return TERRAIN_IDS.some((t) => p[t] > 0);
}
