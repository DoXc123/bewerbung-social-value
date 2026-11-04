/**
 * modifiers.ts — the skill-tree seam (PLAN-open-sea §3.6). Every formula that a bonus could touch
 * takes a `Modifiers`; nothing hard-codes one. Today every entry is the identity.
 */
import { UNDERWAY_PRODUCTION_PCT } from './config';
import type { Modifiers } from './types';

export const IDENTITY_MODIFIERS: Modifiers = {
  islandSpeed: 1,
  underwayProductionPct: UNDERWAY_PRODUCTION_PCT,
};
