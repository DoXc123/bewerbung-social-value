// S3a.1 — speed, the mover, clamp, ETA (specs/S3a.md §S3a.1).
import { describe, expect, it } from 'vitest';
import { SPAWN_POS, SPEED_FLOOR, TRAVEL_RADIUS_U, V_BASE_U_PER_H } from '../../src/core/config';
import { IDENTITY_MODIFIERS } from '../../src/core/modifiers';
import { MS_PER_HOUR } from '../../src/core/types';
import type { Modifiers, Mover } from '../../src/core/types';
import { clampToTravel, dist, etaOf, headingAt, holdingAt, planCourse, positionAt } from '../../src/core/world/mover';
import { islandSpeed } from '../../src/core/world/speed';

const MODS = IDENTITY_MODIFIERS;

describe('islandSpeed', () => {
  it('pins: 7 → 72, 20 → 72, 400 → 72·(1/20)^0.25, 2000 → 72·0.4', () => {
    expect(islandSpeed(7, MODS)).toBe(72);
    expect(islandSpeed(20, MODS)).toBe(72);
    expect(islandSpeed(400, MODS)).toBeCloseTo(72 * Math.pow(1 / 20, 0.25), 10);
    expect(islandSpeed(400, MODS)).toBeCloseTo(34.05, 2);
    expect(islandSpeed(2000, MODS)).toBeCloseTo(28.8, 10);
  });

  it('is non-increasing in tiles and never below the floor', () => {
    let prev = Infinity;
    for (let tiles = 1; tiles <= 100_000; tiles = Math.ceil(tiles * 1.3) + 1) {
      const v = islandSpeed(tiles, MODS);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(V_BASE_U_PER_H * SPEED_FLOOR - 1e-9);
      prev = v;
    }
    expect(islandSpeed(10_000_000, MODS)).toBeCloseTo(V_BASE_U_PER_H * SPEED_FLOOR, 10);
  });

  it('multiplies by the modifier', () => {
    const fast: Modifiers = { ...MODS, islandSpeed: 1.5 };
    expect(islandSpeed(400, fast)).toBeCloseTo(islandSpeed(400, MODS) * 1.5, 10);
    expect(islandSpeed(7, fast)).toBe(108);
  });
});

describe('clampToTravel', () => {
  it('leaves points inside the disc alone', () => {
    expect(clampToTravel({ x: 10, z: -20 })).toEqual({ x: 10, z: -20 });
    expect(clampToTravel({ x: TRAVEL_RADIUS_U, z: 0 })).toEqual({ x: TRAVEL_RADIUS_U, z: 0 });
  });
  it('projects points outside radially onto the rim', () => {
    const p = clampToTravel({ x: 3 * TRAVEL_RADIUS_U, z: 4 * TRAVEL_RADIUS_U });
    expect(dist(p, SPAWN_POS)).toBeCloseTo(TRAVEL_RADIUS_U, 9);
    expect(p.x / p.z).toBeCloseTo(3 / 4, 9);
  });
});

describe('planCourse / positionAt / headingAt / etaOf', () => {
  it('one leg, integer ms: tEnd = now + ceil(dist / speed · MS_PER_HOUR) (min 1)', () => {
    const m = planCourse({ x: 0, z: 0 }, { x: 72, z: 0 }, 7, MODS, 1000);
    expect(m.state).toBe('underway');
    expect(m.path).toEqual([{ x: 0, z: 0 }, { x: 72, z: 0 }]);
    expect(m.legs).toEqual([{ tStart: 1000, tEnd: 1000 + MS_PER_HOUR }]);
    expect(m.departAt).toBe(1000);
    expect(etaOf(m)).toBe(1000 + MS_PER_HOUR);
    const odd = planCourse({ x: 0, z: 0 }, { x: 1.1, z: 0 }, 7, MODS, 0);
    expect(Number.isInteger(odd.legs[0].tEnd)).toBe(true);
    expect(odd.legs[0].tEnd).toBe(Math.ceil((1.1 / 72) * MS_PER_HOUR));
    expect(planCourse({ x: 5, z: 5 }, { x: 5, z: 5 }, 7, MODS, 10).legs[0].tEnd).toBe(11);
  });

  it('clamps the target first', () => {
    const m = planCourse({ x: 0, z: 0 }, { x: 10_000, z: 0 }, 7, MODS, 0);
    expect(m.path[1].x).toBeCloseTo(TRAVEL_RADIUS_U, 9);
    expect(m.legs[0].tEnd).toBe(Math.ceil((TRAVEL_RADIUS_U / 72) * MS_PER_HOUR));
  });

  it('speed/ETA over 100 u for 7, 400 and 2000 tiles', () => {
    const eta = (tiles: number) => planCourse({ x: 0, z: 0 }, { x: 100, z: 0 }, tiles, MODS, 0).legs[0].tEnd;
    expect(eta(7)).toBe(Math.ceil((100 / 72) * MS_PER_HOUR));
    expect(eta(400)).toBeGreaterThan(eta(7));
    expect(eta(2000)).toBeGreaterThan(eta(400));
    expect(eta(2000)).toBe(Math.ceil((100 / 28.8) * MS_PER_HOUR));
  });

  it('holding: positionAt is pos, headingAt/etaOf null', () => {
    const h = holdingAt({ x: 3, z: 4 });
    expect(positionAt(h, 12345)).toEqual({ x: 3, z: 4 });
    expect(headingAt(h, 0)).toBeNull();
    expect(etaOf(h)).toBeNull();
  });

  it('underway: linear, clamped into [departAt, tEnd], exact at both ends', () => {
    const m = planCourse({ x: 0, z: 0 }, { x: 72, z: 0 }, 7, MODS, 1000);
    expect(positionAt(m, 0)).toEqual({ x: 0, z: 0 });
    expect(positionAt(m, 1000)).toEqual({ x: 0, z: 0 });
    expect(positionAt(m, 1000 + MS_PER_HOUR / 2)).toEqual({ x: 36, z: 0 });
    expect(positionAt(m, 1000 + MS_PER_HOUR)).toEqual({ x: 72, z: 0 });
    expect(positionAt(m, 1000 + 5 * MS_PER_HOUR)).toEqual({ x: 72, z: 0 });
    expect(headingAt(m, 1000)).toBeCloseTo(0, 12);
    const south = planCourse({ x: 0, z: 0 }, { x: 0, z: 50 }, 7, MODS, 0);
    expect(headingAt(south, 5)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('multi-leg: continuous, monotone in distance from start; ETA = the last leg end (sum of legs)', () => {
    // Corners are S3's; the mover shape already carries them, so positionAt must handle them.
    const m: Mover = {
      state: 'underway',
      pos: { x: 0, z: 0 },
      path: [{ x: 0, z: 0 }, { x: 30, z: 0 }, { x: 30, z: 40 }, { x: 60, z: 40 }],
      departAt: 100,
      legs: [{ tStart: 100, tEnd: 600 }, { tStart: 600, tEnd: 1600 }, { tStart: 1600, tEnd: 2000 }],
    };
    expect(etaOf(m)).toBe(2000);
    expect(etaOf(m)).toBe(100 + 500 + 1000 + 400);
    let prevPos = positionAt(m, 100);
    let travelled = 0;
    for (let t = 100; t <= 2000; t += 7) {
      const p = positionAt(m, t);
      const step = dist(prevPos, p);
      expect(step).toBeLessThan(0.6); // continuous: no jumps (fastest leg moves 0.525 u per 7 ms)
      travelled += step;
      expect(dist(m.path[0], p)).toBeGreaterThanOrEqual(dist(m.path[0], prevPos) - 1e-12); // monotone from the start
      prevPos = p;
    }
    // The sampled chord length stays within a corner's cut of the 100 u polyline.
    expect(travelled).toBeGreaterThan(99);
    expect(travelled).toBeLessThanOrEqual(100 + 1e-9);
    expect(positionAt(m, 600)).toEqual({ x: 30, z: 0 });
    expect(positionAt(m, 1600)).toEqual({ x: 30, z: 40 });
    expect(headingAt(m, 300)).toBeCloseTo(0, 12);
    expect(headingAt(m, 1000)).toBeCloseTo(Math.PI / 2, 12);
    expect(headingAt(m, 1900)).toBeCloseTo(0, 12);
  });

  it('a zero-length leg is its start point', () => {
    const m: Mover = {
      state: 'underway',
      pos: { x: 1, z: 1 },
      path: [{ x: 1, z: 1 }, { x: 1, z: 1 }],
      departAt: 50,
      legs: [{ tStart: 50, tEnd: 50 }],
    };
    expect(positionAt(m, 50)).toEqual({ x: 1, z: 1 });
    expect(positionAt(m, 99)).toEqual({ x: 1, z: 1 });
  });
});
