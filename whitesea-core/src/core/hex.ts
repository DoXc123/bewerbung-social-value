/**
 * hex.ts — flat-top axial hexes on the XZ plane (ONESHOT §3.1), same maths as Unity HexCoord.
 *
 * XZ mapping (three.js, right-handed, y up):  x = s·1.5·q,  z = s·√3·(r + q/2).
 * The camera sits on the +z side looking toward −z, so decreasing r reads as "up" on screen.
 * Adjacency = the 6 distance-1 neighbours only (vertex-sharing cells are distance 2).
 */
import { HEX_SIZE } from './config';
import type { Hex, HexKey } from './types';

export const SQRT3 = Math.sqrt(3);

/** Direction order, pinned to Unity HexCoord: (1,0) (1,−1) (0,−1) (−1,0) (−1,1) (0,1). */
export const HEX_DIRS: readonly Hex[] = [
  { q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 },
  { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 },
];

/** The world bound = the MapID window, q and r in [−26, 25] (ONESHOT §3.8). */
export const WORLD_MIN = -26;
export const WORLD_MAX = 25;
export function inWorld(q: number, r: number): boolean {
  return q >= WORLD_MIN && q <= WORLD_MAX && r >= WORLD_MIN && r <= WORLD_MAX;
}

export function hexKey(q: number, r: number): HexKey {
  return `${q},${r}`;
}

export function keyOf(h: Hex): HexKey {
  return `${h.q},${h.r}`;
}

export function parseKey(key: HexKey): Hex {
  const i = key.indexOf(',');
  return { q: Number(key.slice(0, i)), r: Number(key.slice(i + 1)) };
}

export function neighbors(h: Hex): Hex[] {
  return HEX_DIRS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));
}

/** (|dq| + |dr| + |dq+dr|) / 2 */
export function distance(a: Hex, b: Hex): number {
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

/** Centre of a hex on the XZ plane. */
export function toWorld(h: Hex, size: number = HEX_SIZE): { x: number; z: number } {
  return { x: size * 1.5 * h.q, z: size * SQRT3 * (h.r + h.q / 2) };
}

/** Fractional axial → nearest hex, by cube rounding. */
export function hexRound(fq: number, fr: number): Hex {
  const fs = -fq - fr;
  let q = Math.round(fq);
  let r = Math.round(fr);
  const s = Math.round(fs);
  const dq = Math.abs(q - fq);
  const dr = Math.abs(r - fr);
  const ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  // Normalise −0 so keys are stable.
  return { q: q + 0, r: r + 0 };
}

/** World XZ → the hex containing it (picking). */
export function fromWorld(x: number, z: number, size: number = HEX_SIZE): Hex {
  const fq = ((2 / 3) * x) / size;
  const fr = ((-1 / 3) * x + (SQRT3 / 3) * z) / size;
  return hexRound(fq, fr);
}

/** The cells at exactly `radius` from `center` (radius 0 → [center]). */
export function ring(center: Hex, radius: number): Hex[] {
  if (radius === 0) return [{ q: center.q, r: center.r }];
  const out: Hex[] = [];
  // Start at center + dir[4] * radius, walk each of the 6 sides.
  let h = { q: center.q + HEX_DIRS[4].q * radius, r: center.r + HEX_DIRS[4].r * radius };
  for (let side = 0; side < 6; side++) {
    for (let step = 0; step < radius; step++) {
      out.push(h);
      h = { q: h.q + HEX_DIRS[side].q, r: h.r + HEX_DIRS[side].r };
    }
  }
  return out;
}

/** Every cell within `radius` of `center`, centre first then ring by ring. Count = 1 + 3r(r+1). */
export function spiral(center: Hex, radius: number): Hex[] {
  const out: Hex[] = [];
  for (let k = 0; k <= radius; k++) out.push(...ring(center, k));
  return out;
}

/** 1 + 3r(r+1) */
export function cellsWithin(radius: number): number {
  return 1 + 3 * radius * (radius + 1);
}

/** The six corner offsets of a flat-top hex (corner i at angle 60°·i), for meshes and outlines. */
export function corners(size: number = HEX_SIZE): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    out.push({ x: size * Math.cos(a), z: size * Math.sin(a) });
  }
  return out;
}
