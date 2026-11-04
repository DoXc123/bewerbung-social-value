/**
 * fixtures.ts — a representative mid-game island as a plain layout literal (W0, ONESHOT §5.1.5).
 * Used by the shot mode (`?shot&y=<h>`) before MapID exists, and by tests.
 *
 * TH7 + a VC2 (not "TH5" as §5.1 says: at TH5 the stone chain and every booster but the sawmill
 * are still gated by §3.5, so "all four chains" needs TH7 — logged in PLAN.md). Every record is
 * legal under §3.5/§3.6: inside the territory (TH r4 ∪ VC r2), terrain-gated, levels ≤ 7,
 * connected over 6-neighbours, 53 tiles against a cap of 140. A SurgeCloud ridge runs NE.
 * Sorted by (r, q), the MapID encoder's order.
 */
import type { Layout } from '../core/types';

export const FIXTURE_MIDGAME: Layout = [
  { q: 0, r: -4, terrain: 'mountain', building: null, level: 0 },
  { q: 1, r: -4, terrain: 'mountain', building: null, level: 0 },
  { q: 2, r: -4, terrain: 'mountain', building: 'irondeposit', level: 1 },
  { q: 3, r: -4, terrain: 'mountain', building: 'quarry', level: 1 },
  { q: 4, r: -4, terrain: 'mountain', building: 'quarry', level: 1 },
  { q: 0, r: -3, terrain: 'mountain', building: null, level: 0 },
  { q: 1, r: -3, terrain: 'mountain', building: 'stonegrindery', level: 2 },
  { q: 2, r: -3, terrain: 'mountain', building: 'quarry', level: 1 },
  { q: 3, r: -3, terrain: 'mountain', building: 'stonemason', level: 7 },
  { q: 4, r: -3, terrain: 'mountain', building: 'quarry', level: 1 },
  { q: 0, r: -2, terrain: 'mountain', building: null, level: 0 },
  { q: 1, r: -2, terrain: 'mountain', building: 'irondeposit', level: 1 },
  { q: 2, r: -2, terrain: 'mountain', building: 'quarry', level: 1 },
  { q: 3, r: -2, terrain: 'mountain', building: 'quarry', level: 1 },
  { q: 4, r: -2, terrain: 'mountain', building: 'irondeposit', level: 1 },
  { q: -2, r: -1, terrain: 'land', building: 'sawmill', level: 5 },
  { q: -1, r: -1, terrain: 'land', building: 'forest', level: 1 },
  { q: 0, r: -1, terrain: 'land', building: 'forest', level: 1 },
  { q: 1, r: -1, terrain: 'land', building: 'warehouse', level: 5 },
  { q: 2, r: -1, terrain: 'mountain', building: 'oremine', level: 7 },
  { q: 3, r: -1, terrain: 'mountain', building: 'irondeposit', level: 1 },
  { q: 4, r: -1, terrain: 'mountain', building: 'ironsmelter', level: 1 },
  { q: -4, r: 0, terrain: 'land', building: 'forest', level: 1 },
  { q: -3, r: 0, terrain: 'land', building: 'forest', level: 1 },
  { q: -2, r: 0, terrain: 'land', building: 'forest', level: 1 },
  { q: -1, r: 0, terrain: 'land', building: 'forest', level: 1 },
  { q: 0, r: 0, terrain: 'land', building: 'mainhouse', level: 7 },
  { q: 1, r: 0, terrain: 'land', building: 'lumberjack', level: 4 },
  { q: 2, r: 0, terrain: 'land', building: 'lumberjack', level: 1 },
  { q: 3, r: 0, terrain: 'land', building: null, level: 0 },
  { q: 4, r: 0, terrain: 'land', building: 'forest', level: 1 },
  { q: -4, r: 1, terrain: 'land', building: 'forest', level: 1 },
  { q: -3, r: 1, terrain: 'land', building: 'lumberjack', level: 7 },
  { q: -2, r: 1, terrain: 'land', building: 'forest', level: 1 },
  { q: -1, r: 1, terrain: 'land', building: 'house', level: 2 },
  { q: 0, r: 1, terrain: 'land', building: null, level: 0 },
  { q: 1, r: 1, terrain: 'land', building: 'wheatfield', level: 1 },
  { q: 2, r: 1, terrain: 'land', building: 'wheatfield', level: 1 },
  { q: 3, r: 1, terrain: 'land', building: 'bakery', level: 3 },
  { q: -4, r: 2, terrain: 'land', building: 'forest', level: 1 },
  { q: -3, r: 2, terrain: 'land', building: 'forest', level: 1 },
  { q: -2, r: 2, terrain: 'land', building: null, level: 0 },
  { q: -1, r: 2, terrain: 'land', building: 'wheatfield', level: 1 },
  { q: 0, r: 2, terrain: 'land', building: 'wheatfield', level: 1 },
  { q: 1, r: 2, terrain: 'land', building: 'farm', level: 7 },
  { q: 2, r: 2, terrain: 'land', building: 'wheatfield', level: 1 },
  { q: -4, r: 3, terrain: 'land', building: 'forest', level: 1 },
  { q: -3, r: 3, terrain: 'land', building: null, level: 0 },
  { q: -2, r: 3, terrain: 'land', building: 'villagecentre', level: 2 },
  { q: -1, r: 3, terrain: 'land', building: 'wheatfield', level: 1 },
  { q: 0, r: 3, terrain: 'land', building: 'wheatfield', level: 1 },
  { q: 1, r: 3, terrain: 'land', building: 'wheatfield', level: 1 },
  { q: -1, r: 4, terrain: 'land', building: 'wheatfield', level: 1 },
];

/** The fixture's seed: the TH cell and its 6 neighbours (all land). */
export const FIXTURE_SEED_RADIUS = 1;
