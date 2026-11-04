/**
 * territory.ts — territory, storage/population capacity, connectivity and buildable cells
 * (ONESHOT §3.6, §3.12 job 2), plus the tile effect of a queue item completing and the
 * structural placement check shared by `validate`, the queue replay and `buildableCells`.
 */
import { MAX_QUEUE } from './config';
import { hexKey, neighbors, parseKey, spiral, inWorld } from './hex';
import type { CapacityFn, Hex, HexKey, IslandState, QueueItem, Reason, Tile } from './types';

/** Union of spheres radius min(L, 4) around the mainhouse and every village centre. */
export function territorySet(tiles: Record<HexKey, Tile>): Set<HexKey> {
  const out = new Set<HexKey>();
  for (const key in tiles) {
    const t = tiles[key];
    if (!t.building) continue;
    if (t.building.id !== 'mainhouse' && t.building.id !== 'villagecentre') continue;
    const r = Math.min(t.building.level, 4);
    for (const c of spiral({ q: t.q, r: t.r }, r)) out.add(hexKey(c.q, c.r));
  }
  return out;
}

/** 500 + Σ over warehouses of 25·L·(9+L) — the exact integer form. */
export function storageCap(tiles: Record<HexKey, Tile>): number {
  let total = 500;
  for (const key in tiles) {
    const t = tiles[key];
    if (t.building?.id === 'warehouse') {
      const l = t.building.level;
      total += 25 * l * (9 + l);
    }
  }
  return total;
}

export const capacity: CapacityFn = (tiles: Record<HexKey, Tile>) => {
  let townHallLevel = 0;
  let villageCentreLevel = 0;
  let houseCount = 0;
  let houseLevelSum = 0;
  let islandSize = 0;

  for (const key in tiles) {
    islandSize++;
    const t = tiles[key];
    if (!t.building) continue;
    if (t.building.id === 'mainhouse') {
      townHallLevel = t.building.level;
    } else if (t.building.id === 'villagecentre') {
      villageCentreLevel = Math.max(villageCentreLevel, t.building.level);
    } else if (t.building.id === 'house') {
      houseCount++;
      houseLevelSum += t.building.level;
    }
  }

  return {
    storage: storageCap(tiles),
    populationCap: 500 + 500 * houseLevelSum,
    populationPerHour: 2 + houseCount,
    territory: [...territorySet(tiles)],
    islandCap: 20 * townHallLevel,
    islandSize,
    townHallLevel,
    villageCentreLevel,
  };
};

/** Flood fill from the mainhouse over 6-neighbours; interior holes are fine, a split is not. */
export function isConnected(tiles: Record<HexKey, Tile>): boolean {
  const keys = Object.keys(tiles);
  if (keys.length === 0) return true;

  let start: HexKey | undefined;
  for (const k of keys) {
    if (tiles[k].building?.id === 'mainhouse') {
      start = k;
      break;
    }
  }
  if (!start) start = keys[0];

  const visited = new Set<HexKey>([start]);
  const stack: HexKey[] = [start];
  while (stack.length > 0) {
    const cur = stack.pop() as HexKey;
    const t = tiles[cur];
    for (const n of neighbors({ q: t.q, r: t.r })) {
      const nk = hexKey(n.q, n.r);
      if (tiles[nk] && !visited.has(nk)) {
        visited.add(nk);
        stack.push(nk);
      }
    }
  }
  return visited.size === keys.length;
}

/**
 * The tiles after `item` completes: build → the building at L1; upgrade → its level; demolish →
 * bare terrain; place → a new bare, non-seed tile (S0.1). A `place` onto a cell that is somehow
 * already occupied (a hand-edited save) leaves that tile alone. Never mutates `tiles`.
 */
export function completeTiles(tiles: Record<HexKey, Tile>, item: QueueItem): Record<HexKey, Tile> {
  const key = hexKey(item.q, item.r);
  const tile = tiles[key];
  switch (item.kind) {
    case 'build':
      return { ...tiles, [key]: { ...tile, building: { id: item.building, level: 1 } } };
    case 'upgrade':
      return { ...tiles, [key]: { ...tile, building: { ...tile.building!, level: item.level } } };
    case 'demolish':
      return { ...tiles, [key]: { ...tile, building: null } };
    case 'place':
      if (tile) return tiles;
      return { ...tiles, [key]: { q: item.q, r: item.r, terrain: item.terrain, seed: false, building: null } };
  }
}

/** The tiles as if every queued item had completed, in order (layout only — see sim.project). */
export function projectTiles(tiles: Record<HexKey, Tile>, queue: readonly QueueItem[]): Record<HexKey, Tile> {
  let out = tiles;
  for (const item of queue) out = completeTiles(out, item);
  return out;
}

/**
 * The structural half of a terrain placement (S0.1), checked against whatever `tiles` the caller
 * hands in — the projection for `validate`/`buildableCells`, the replay state for a queued
 * `place` at its turn: the cell is empty, touches the island, lies inside the territory and the
 * world window, and the island is under its cap. Pieces and queue room are the caller's.
 */
export function placeReason(tiles: Record<HexKey, Tile>, q: number, r: number): Reason | null {
  if (tiles[hexKey(q, r)]) return { code: 'occupied' };
  if (!neighbors({ q, r }).some((n) => !!tiles[hexKey(n.q, n.r)])) return { code: 'notAdjacent' };
  const cap = capacity(tiles);
  if (!inWorld(q, r) || !new Set(cap.territory).has(hexKey(q, r))) return { code: 'outsideTerritory' };
  if (cap.islandSize >= cap.islandCap) return { code: 'islandFull', cap: cap.islandCap };
  return null;
}

/**
 * The cells a `placeTerrain` would validate on right now, for *some* terrain (S0.1): empty,
 * adjacent, in territory and under the cap in the PROJECTED island (so a queued `place`'s cell
 * is not offered and the cells next to it are), with a piece in hand and room in the queue.
 * Sorted by (r, q).
 */
export function buildableCells(state: IslandState): Hex[] {
  if (state.queue.length >= MAX_QUEUE) return [];
  if (state.pieces.land <= 0 && state.pieces.mountain <= 0) return [];
  const tiles = projectTiles(state.tiles, state.queue);
  const cap = capacity(tiles);
  if (cap.islandSize >= cap.islandCap) return [];

  const territory = new Set(cap.territory);
  const candidates = new Set<HexKey>();
  for (const key in tiles) {
    const t = tiles[key];
    for (const n of neighbors({ q: t.q, r: t.r })) {
      const nk = hexKey(n.q, n.r);
      if (tiles[nk]) continue;
      if (!territory.has(nk)) continue;
      if (!inWorld(n.q, n.r)) continue; // same bound as placeTerrain's verdict
      candidates.add(nk);
    }
  }

  const out = [...candidates].map(parseKey);
  out.sort((a, b) => a.r - b.r || a.q - b.q);
  return out;
}
