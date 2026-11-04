/**
 * speed.ts — how fast the island travels (PLAN-open-sea §4 S3): world units per game-hour, falling
 * as the island grows, never below SPEED_FLOOR of the base.
 */
import { SPEED_ALPHA, SPEED_FLOOR, SPEED_REF_TILES, V_BASE_U_PER_H } from '../config';
import type { IslandSpeedFn } from '../types';

export const islandSpeed: IslandSpeedFn = (tiles, mods) => {
  const scale = Math.max(SPEED_FLOOR, Math.pow(SPEED_REF_TILES / Math.max(tiles, SPEED_REF_TILES), SPEED_ALPHA));
  return V_BASE_U_PER_H * scale * mods.islandSpeed;
};
