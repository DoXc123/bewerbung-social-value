/**
 * costtime.ts — cost & build time. Integer arithmetic for costs, so the numbers are identical
 * on every platform and can be pinned in tests.
 */
import { DEMOLISH_REFUND_PCT, DEMOLISH_TIME_PCT } from './config';
import { radius } from './economy';
import { getDef } from './catalog';
import type { BuildingId, ResourceVec } from './types';
import { RESOURCES } from './types';

/** cost_r(L) = n ≥ 1 ? floor(base·n·(n+3)/4) : 0, n = L − from. */
export function costAt(id: BuildingId, level: number): ResourceVec {
  const def = getDef(id);
  const out: ResourceVec = { wood: 0, food: 0, stone: 0, iron: 0 };
  for (const res of RESOURCES) {
    const param = def.cost[res];
    if (!param) continue;
    const n = level - param.from;
    if (n < 1) continue;
    out[res] = Math.floor((param.base * n * (n + 3)) / 4);
  }
  return out;
}

/** builders(L) = radius(L): 1 (L ≤ 6) · 2 (7–18) · 3 (≥ 19). */
export function builders(level: number): number {
  return radius(level);
}

/** villagecentre builds with 5 builders at every level; mainhouse never uses this. */
export function buildersFor(id: BuildingId, level: number): number {
  if (id === 'villagecentre') return 5;
  return builders(level);
}

function totalCost(id: BuildingId, level: number): number {
  const v = costAt(id, level);
  return v.wood + v.food + v.stone + v.iron;
}

function curve(l: number): number {
  return l <= 10 ? 0.7 : 0.85;
}

/** Asymptotic soft cap toward K. */
function soft(x: number, k: number): number {
  return x < k ? x : k + k * (1 - k / x);
}

/** Rounded to the nearest second. Town hall: soft(4c, K) — no curve, no builder division. */
export function secondsAt(id: BuildingId, level: number): number {
  const c = totalCost(id, level);
  if (id === 'mainhouse') {
    const k = level <= 5 ? 300 : 43_200;
    return Math.round(soft(4 * c, k));
  }
  const b = buildersFor(id, level);
  return Math.round(curve(level - 1) * soft((4 * c) / b, 43_200));
}

export function durationMs(id: BuildingId, level: number): number {
  return secondsAt(id, level) * 1000;
}

export function demolishMs(id: BuildingId, level: number): number {
  return (DEMOLISH_TIME_PCT * durationMs(id, level)) / 100;
}

/** Σ costAt(id, l) for l = 1..L (mainhouse: l = 2..L, since L1 is the never-built seed). */
export function investedThrough(id: BuildingId, level: number): ResourceVec {
  const out: ResourceVec = { wood: 0, food: 0, stone: 0, iron: 0 };
  const start = id === 'mainhouse' ? 2 : 1;
  for (let l = start; l <= level; l++) {
    const c = costAt(id, l);
    for (const res of RESOURCES) out[res] += c[res];
  }
  return out;
}

export function demolishRefund(id: BuildingId, level: number): ResourceVec {
  const invested = investedThrough(id, level);
  const out: ResourceVec = { wood: 0, food: 0, stone: 0, iron: 0 };
  for (const res of RESOURCES) out[res] = Math.floor((invested[res] * DEMOLISH_REFUND_PCT) / 100);
  return out;
}
