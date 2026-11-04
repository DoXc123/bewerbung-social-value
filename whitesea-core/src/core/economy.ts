/**
 * economy.ts — production (ONESHOT §3.3): radius/baseYield/boost, per-producer detail,
 * per-resource totals including the town hall's unconditional +5 wood/+5 food.
 */
import { getDef } from './catalog';
import { cellsWithin, distance, hexKey, spiral } from './hex';
import type {
  BoosterReach,
  BuildingId,
  Hex,
  HexKey,
  ProducerDetail,
  ProductionFn,
  Resource,
  ResourceVec,
  Tile,
  TileContribution,
} from './types';

/** Rings of reach: L < 7 → 1 · 7 ≤ L ≤ 18 → 2 · L ≥ 19 → 3. */
export function radius(level: number): number {
  if (level < 7) return 1;
  if (level <= 18) return 2;
  return 3;
}

/** Base yield per worked field, before boosters. */
export function baseYield(level: number): number {
  const l = level < 1 ? 1 : level;
  if (l < 7) return 5 + 2 * (l - 1);
  if (l <= 18) return 15 + (l - 6);
  return 27 + Math.floor((l - 18) / 2);
}

/** base + ceil(base·pct/100), integer: base + floor((base·pct + 99) / 100). */
export function boostedYield(base: number, pct: number): number {
  if (pct <= 0) return base;
  return base + Math.floor((base * pct + 99) / 100);
}

function zeroVec(): ResourceVec {
  return { wood: 0, food: 0, stone: 0, iron: 0 };
}

interface ResourceActor {
  q: number;
  r: number;
  id: BuildingId;
  level: number;
  resource: Resource;
}

function ensureContribution(
  contributions: Record<HexKey, TileContribution>,
  key: HexKey,
): TileContribution {
  let c = contributions[key];
  if (!c) {
    c = { feeds: [], workedBy: [] };
    contributions[key] = c;
  }
  return c;
}

export const computeProduction: ProductionFn = (tiles: Record<HexKey, Tile>) => {
  const producers: ResourceActor[] = [];
  const boosters: ResourceActor[] = [];
  let hasMainhouse = false;

  for (const key in tiles) {
    const t = tiles[key];
    if (!t.building) continue;
    if (t.building.id === 'mainhouse') hasMainhouse = true;
    const def = getDef(t.building.id);
    if (def.role === 'producer') {
      producers.push({ q: t.q, r: t.r, id: t.building.id, level: t.building.level, resource: def.resource as Resource });
    } else if (def.role === 'booster') {
      boosters.push({ q: t.q, r: t.r, id: t.building.id, level: t.building.level, resource: def.resource as Resource });
    }
  }

  const perHour = zeroVec();
  const producersOut: Record<HexKey, ProducerDetail> = {};
  const contributions: Record<HexKey, TileContribution> = {};

  for (const p of producers) {
    const pKey = hexKey(p.q, p.r);
    const centre: Hex = { q: p.q, r: p.r };
    const r = radius(p.level);
    const reach = spiral(centre, r).filter((c) => !(c.q === p.q && c.r === p.r));
    const scanned = cellsWithin(r);

    const eligibleFields: Hex[] = [];
    for (const c of reach) {
      const tile = tiles[hexKey(c.q, c.r)];
      if (!tile?.building) continue;
      const d = getDef(tile.building.id);
      if (d.role === 'field' && d.resource === p.resource) eligibleFields.push(c);
    }

    const worked = Math.min(eligibleFields.length, p.level, 25);
    const workedFields = [...eligibleFields]
      .sort((a, b) => {
        const da = distance(centre, a);
        const db = distance(centre, b);
        if (da !== db) return da - db;
        if (a.q !== b.q) return a.q - b.q;
        return a.r - b.r;
      })
      .slice(0, worked);

    const boosterDetails: BoosterReach[] = [];
    let boostPct = 0;
    for (const b of boosters) {
      if (b.resource !== p.resource) continue;
      const bRadius = radius(b.level);
      if (distance({ q: b.q, r: b.r }, centre) <= bRadius) {
        const pct = b.level * 5;
        boostPct += pct;
        boosterDetails.push({ q: b.q, r: b.r, building: b.id, level: b.level, pct });
      }
    }

    const base = baseYield(p.level);
    const yieldPerField = boostedYield(base, boostPct);
    const production = worked * yieldPerField;

    producersOut[pKey] = {
      q: p.q,
      r: p.r,
      building: p.id,
      resource: p.resource,
      level: p.level,
      radius: r,
      scanned,
      eligible: eligibleFields.length,
      worked,
      baseYield: base,
      boostPct,
      yieldPerField,
      production,
      reach,
      eligibleFields,
      workedFields,
      boosters: boosterDetails,
    };

    perHour[p.resource] += production;

    for (const f of eligibleFields) ensureContribution(contributions, hexKey(f.q, f.r)).feeds.push(pKey);
    for (const f of workedFields) ensureContribution(contributions, hexKey(f.q, f.r)).workedBy.push(pKey);
    for (const b of boosterDetails) ensureContribution(contributions, hexKey(b.q, b.r)).feeds.push(pKey);
  }

  if (hasMainhouse) {
    perHour.wood += 5;
    perHour.food += 5;
  }

  return { perHour, producers: producersOut, contributions };
};
