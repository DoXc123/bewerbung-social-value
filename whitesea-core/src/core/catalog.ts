/**
 * catalog.ts — the roster (ONESHOT §3.2), cost parameters (§3.4) and unlocks/max levels (§3.5).
 * Engine ids stay generic; display names are placeholders (themed names are a display layer).
 *
 * ⚠ "Quarry" trap: our `quarry` is the stone FIELD; the PRODUCER that works it is `stonemason`.
 * Unlock gates live here in the catalog, never in external data.
 */
import { CITY_TERRAIN } from './config';
import type { BuildingDef, BuildingId, CostParam, Resource, Role } from './types';
import { BUILDING_IDS } from './types';

type CostRow = [CostParam | null, CostParam | null, CostParam | null, CostParam | null];
const c = (base: number, from: number): CostParam => ({ base, from });
const cost = (row: CostRow): Record<Resource, CostParam | null> => ({
  wood: row[0], food: row[1], stone: row[2], iron: row[3],
});

function def(
  id: BuildingId, role: Role, resource: Resource | null, terrain: 'land' | 'mountain',
  displayName: string, maxLevel: number, row: CostRow,
  unlock: BuildingDef['unlock'],
): BuildingDef {
  return { id, role, resource, terrain, displayName, maxLevel, cost: cost(row), unlock };
}

// Costs are placeholders: round numbers, one size per role, not tuned. Fields cost wood and food only.
// Every other building asks for iron from L5 and stone from L8, so nothing needs a resource the island
// cannot produce yet (iron deposit at TH3, quarry at TH6). The town hall's curve starts at L2, its first build.
export const CATALOG: Record<BuildingId, BuildingDef> = {
  // city — land only (§6). The town hall is the seed: never built, never demolished.
  // Its maxLevel is nominal: the village-centre gate (TH ≥ 6 needs VC ≥ L − 5, §3.5) caps it at
  // 20 in practice — 400 tiles (DECISIONS 2026-09-25 #2, #11).
  mainhouse: def('mainhouse', 'city', null, CITY_TERRAIN, 'Main House', 25,
    [c(200, 1), c(200, 1), c(100, 7), c(100, 4)], { kind: 'seed' }),
  // Max 15, not 4 (DECISIONS 2026-09-25 #11, Open Sea S0.3), on the same §3.4 curves.
  villagecentre: def('villagecentre', 'city', null, CITY_TERRAIN, 'Village Centre', 15,
    [c(150, 0), c(150, 0), c(80, 7), c(80, 4)], { kind: 'townHall', level: 5 }),
  warehouse: def('warehouse', 'city', null, CITY_TERRAIN, 'Warehouse', 25,
    [c(100, 0), c(100, 0), c(50, 7), c(50, 4)], { kind: 'townHall', level: 2 }),
  house: def('house', 'city', null, CITY_TERRAIN, 'House', 25,
    [c(120, 0), c(120, 0), c(60, 7), c(60, 4)], { kind: 'townHall', level: 7 }),

  // fields — level 1 forever
  forest: def('forest', 'field', 'wood', 'land', 'Forest', 1,
    [c(30, 0), c(30, 0), null, null], { kind: 'townHall', level: 1 }),
  // wheatfield + farm at TH1, not TH5: they stand in for a fishery (the TH1 food source in the
  // reference design), which this build cuts with water. Without it food is +5/h until TH5 (§8 pass, 2026-09-24).
  wheatfield: def('wheatfield', 'field', 'food', 'land', 'Wheatfield', 1,
    [c(30, 0), c(30, 0), null, null], { kind: 'townHall', level: 1 }),
  quarry: def('quarry', 'field', 'stone', 'mountain', 'Quarry', 1,
    [c(60, 0), c(60, 0), null, null], { kind: 'townHall', level: 6 }),
  irondeposit: def('irondeposit', 'field', 'iron', 'mountain', 'Iron Deposit', 1,
    [c(60, 0), c(60, 0), null, null], { kind: 'townHall', level: 3 }),

  // producers — max 25
  lumberjack: def('lumberjack', 'producer', 'wood', 'land', 'Lumberjack', 25,
    [c(50, 0), c(50, 0), c(30, 7), c(30, 4)], { kind: 'townHall', level: 1 }),
  farm: def('farm', 'producer', 'food', 'land', 'Farm', 25,
    [c(50, 0), c(50, 0), c(30, 7), c(30, 4)], { kind: 'townHall', level: 1 }),
  stonemason: def('stonemason', 'producer', 'stone', 'mountain', 'Stonemason', 25,
    [c(100, 0), c(100, 0), c(50, 7), c(50, 4)], { kind: 'townHall', level: 6 }),
  oremine: def('oremine', 'producer', 'iron', 'mountain', 'Ore Mine', 25,
    [c(100, 0), c(100, 0), c(50, 7), c(50, 4)], { kind: 'townHall', level: 3 }),

  // boosters — max 20, unlocked behind their producer's high-water level
  sawmill: def('sawmill', 'booster', 'wood', 'land', 'Sawmill', 20,
    [c(150, 0), c(150, 0), c(100, 7), c(100, 4)], { kind: 'building', building: 'lumberjack', level: 3 }),
  bakery: def('bakery', 'booster', 'food', 'land', 'Bakery', 20,
    [c(150, 0), c(150, 0), c(100, 7), c(100, 4)], { kind: 'building', building: 'farm', level: 7 }),
  stonegrindery: def('stonegrindery', 'booster', 'stone', 'mountain', 'Stone Grindery', 20,
    [c(250, 0), c(250, 0), c(150, 7), c(150, 4)], { kind: 'building', building: 'stonemason', level: 7 }),
  ironsmelter: def('ironsmelter', 'booster', 'iron', 'mountain', 'Iron Smelter', 20,
    [c(250, 0), c(250, 0), c(150, 7), c(150, 4)], { kind: 'building', building: 'oremine', level: 7 }),
};

export function getDef(id: BuildingId): BuildingDef {
  return CATALOG[id];
}

export const ALL_DEFS: readonly BuildingDef[] = BUILDING_IDS.map((id) => CATALOG[id]);

function byRole(role: Role, resource: Resource): BuildingId {
  const d = ALL_DEFS.find((x) => x.role === role && x.resource === resource);
  if (!d) throw new Error(`no ${role} for ${resource}`);
  return d.id;
}

export const FIELD_OF: Record<Resource, BuildingId> = {
  wood: byRole('field', 'wood'), food: byRole('field', 'food'),
  stone: byRole('field', 'stone'), iron: byRole('field', 'iron'),
};
export const PRODUCER_OF: Record<Resource, BuildingId> = {
  wood: byRole('producer', 'wood'), food: byRole('producer', 'food'),
  stone: byRole('producer', 'stone'), iron: byRole('producer', 'iron'),
};
export const BOOSTER_OF: Record<Resource, BuildingId> = {
  wood: byRole('booster', 'wood'), food: byRole('booster', 'food'),
  stone: byRole('booster', 'stone'), iron: byRole('booster', 'iron'),
};

export const isField = (id: BuildingId): boolean => CATALOG[id].role === 'field';
export const isProducer = (id: BuildingId): boolean => CATALOG[id].role === 'producer';
export const isBooster = (id: BuildingId): boolean => CATALOG[id].role === 'booster';
export const isCity = (id: BuildingId): boolean => CATALOG[id].role === 'city';
