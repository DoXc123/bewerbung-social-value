/**
 * mover.ts — the island's movement as a timestamped path (PLAN-open-sea §3.3). Positions are never
 * stepped: `positionAt` is a pure function of the mover and the clock, so offline catch-up is free.
 */
import { MOVE_EPSILON_U, SPAWN_POS, TRAVEL_RADIUS_U } from '../config';
import { islandSpeed } from './speed';
import { MS_PER_HOUR } from '../types';
import type { GameMs, Modifiers, Mover, PositionAtFn, Vec2 } from '../types';

export function holdingAt(pos: Vec2): Mover {
  return { state: 'holding', pos: { x: pos.x, z: pos.z }, path: [], departAt: 0, legs: [] };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** Radial projection onto the travel disc (inside → unchanged). */
export function clampToTravel(p: Vec2): Vec2 {
  const dx = p.x - SPAWN_POS.x;
  const dz = p.z - SPAWN_POS.z;
  const d = Math.hypot(dx, dz);
  if (d <= TRAVEL_RADIUS_U) return { x: p.x, z: p.z };
  const k = TRAVEL_RADIUS_U / d;
  return { x: SPAWN_POS.x + dx * k, z: SPAWN_POS.z + dz * k };
}

export const positionAt: PositionAtFn = (mover, t) => {
  if (mover.state === 'holding' || mover.legs.length === 0) return { x: mover.pos.x, z: mover.pos.z };
  const last = mover.legs[mover.legs.length - 1];
  const tc = Math.min(Math.max(t, mover.departAt), last.tEnd);
  for (let i = 0; i < mover.legs.length; i++) {
    const leg = mover.legs[i];
    const a = mover.path[i];
    const b = mover.path[i + 1];
    if (tc < leg.tStart) return { x: a.x, z: a.z };
    if (tc <= leg.tEnd) {
      const len = leg.tEnd - leg.tStart;
      if (len <= 0 || tc === leg.tStart) return { x: a.x, z: a.z };
      if (tc === leg.tEnd) return { x: b.x, z: b.z };
      const f = (tc - leg.tStart) / len;
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
    }
  }
  const end = mover.path[mover.path.length - 1];
  return { x: end.x, z: end.z };
};

/** Radians, atan2(dz, dx) of the leg containing `t`; null while holding. */
export function headingAt(mover: Mover, t: GameMs): number | null {
  if (mover.state === 'holding' || mover.legs.length === 0) return null;
  let i = mover.legs.length - 1;
  for (let k = 0; k < mover.legs.length; k++) {
    if (t <= mover.legs[k].tEnd) {
      i = k;
      break;
    }
  }
  const a = mover.path[i];
  const b = mover.path[i + 1];
  return Math.atan2(b.z - a.z, b.x - a.x);
}

/** When the course ends (the last leg's tEnd); null while holding. */
export function etaOf(mover: Mover): GameMs | null {
  if (mover.state === 'holding' || mover.legs.length === 0) return null;
  return mover.legs[mover.legs.length - 1].tEnd;
}

/** The end of the course (underway) or where it holds. */
export function destinationOf(mover: Mover): Vec2 {
  if (mover.state === 'holding' || mover.path.length === 0) return mover.pos;
  return mover.path[mover.path.length - 1];
}

/**
 * One straight leg from → clamp(target). The speed is fixed here, at departure, from the island's
 * size then — removing a tile mid-voyage does not re-time the course.
 */
export function planCourse(from: Vec2, target: Vec2, tiles: number, mods: Modifiers, now: GameMs): Mover {
  const to = clampToTravel(target);
  const speed = islandSpeed(tiles, mods);
  const ms = Math.max(1, Math.ceil((dist(from, to) / speed) * MS_PER_HOUR));
  return {
    state: 'underway',
    pos: { x: from.x, z: from.z },
    path: [{ x: from.x, z: from.z }, to],
    departAt: now,
    legs: [{ tStart: now, tEnd: now + ms }],
  };
}

/** True when two points are closer than a course is worth (MOVE_EPSILON_U). */
export function withinEpsilon(a: Vec2, b: Vec2): boolean {
  return dist(a, b) < MOVE_EPSILON_U;
}
