/**
 * layout.ts — Layout ↔ tiles glue (W0). A Layout is the MapID/planner/fixture view of an island;
 * `tiles` is the state view. Seed = every cell within `seedRadius` of the town hall.
 */
import { distance, hexKey } from './hex';
import type { HexKey, Layout, LayoutRecord, Tile } from './types';

/** Build the tile map from a layout. Seed flags: cells within seedRadius of the mainhouse (none if no TH). */
export function layoutToTiles(layout: Layout, seedRadius = 1): Record<HexKey, Tile> {
  const th = layout.find((t) => t.building === 'mainhouse');
  const tiles: Record<HexKey, Tile> = {};
  for (const rec of layout) {
    tiles[hexKey(rec.q, rec.r)] = {
      q: rec.q,
      r: rec.r,
      terrain: rec.terrain,
      seed: th ? distance(rec, th) <= seedRadius : false,
      building: rec.building ? { id: rec.building, level: rec.level } : null,
    };
  }
  return tiles;
}

/** The layout of a tile map, sorted by (r, q) — the MapID encoder's byte-stable order. */
export function tilesToLayout(tiles: Record<HexKey, Tile>): Layout {
  const out: LayoutRecord[] = Object.values(tiles).map((t) => ({
    q: t.q,
    r: t.r,
    terrain: t.terrain,
    building: t.building ? t.building.id : null,
    level: t.building ? t.building.level : 0,
  }));
  out.sort((a, b) => a.r - b.r || a.q - b.q);
  return out;
}
