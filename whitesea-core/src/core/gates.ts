/**
 * gates.ts — unlock and level gates (ONESHOT §3.5). Pure lookups against the catalog; no
 * state mutation.
 */
import { getDef } from './catalog';
import type { BuildingId, Reason } from './types';

/** §3.5 unlock table + the booster high-water gate. mainhouse is the seed: never built. */
export function unlockReason(
  id: BuildingId,
  thLevel: number,
  highWater: Partial<Record<BuildingId, number>>,
): Reason | null {
  const def = getDef(id);
  if (def.unlock.kind === 'seed') return { code: 'townHallPermanent' };
  if (def.unlock.kind === 'townHall') {
    return thLevel < def.unlock.level ? { code: 'lockedByTownHall', need: def.unlock.level } : null;
  }
  const have = highWater[def.unlock.building] ?? 0;
  return have < def.unlock.level
    ? { code: 'lockedByBuilding', building: def.unlock.building, level: def.unlock.level }
    : null;
}

/** maxLevel; the town-hall ceiling for every non-TH building; the VC gate above TH L5. */
export function levelReason(
  id: BuildingId,
  targetLevel: number,
  thLevel: number,
  vcLevel: number,
): Reason | null {
  const def = getDef(id);
  if (targetLevel > def.maxLevel) return { code: 'maxLevel', max: def.maxLevel };
  if (id !== 'mainhouse' && targetLevel > thLevel) {
    return { code: 'lockedByTownHall', need: targetLevel };
  }
  if (id === 'mainhouse' && targetLevel >= 6) {
    const need = targetLevel - 5;
    if (vcLevel < need) return { code: 'lockedByBuilding', building: 'villagecentre', level: need };
  }
  return null;
}
