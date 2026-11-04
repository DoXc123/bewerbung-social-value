/**
 * game.ts — the whole game: the island and the sea (PLAN-open-sea §3.3, specs/S3a.md §S3a.2).
 * `advanceGame` splits the island's `advance` at every sea event (an arrival) so the coupling —
 * production at 75% underway, placement paused — is exact and associative, and offline catch-up
 * is one call. `validateSea` / `applySea` are the pure command pair for the sea, like sim.ts's.
 */
import { createAdvance } from './clock';
import { MOVE_EPSILON_U, SPAWN_POS, WORLD_SEED_DEFAULT, grantTablePieceSource } from './config';
import { IDENTITY_MODIFIERS } from './modifiers';
import { pausePlaceHead, resumePlaceHead } from './queue';
import { newIsland } from './sim';
import { capacity } from './territory';
import type {
  AdvanceGameFn, ApplySeaFn, GameEvent, GameMs, GameState, IslandState, PieceSource, Quote, SeaEvent, SeaState,
  ValidateSeaFn, Vec2,
} from './types';
import { clampToTravel, destinationOf, dist, etaOf, holdingAt, planCourse, positionAt } from './world/mover';

function zeroQuote(): Quote {
  const zero = { wood: 0, food: 0, stone: 0, iron: 0 };
  return { cost: { ...zero }, refund: { ...zero }, durationMs: 0, building: null, level: 0 };
}

/** A sea with the island holding at SPAWN_POS (a new game, a migrated v1 save, a repaired sea block). */
export function newSea(): SeaState {
  return {
    worldSeed: WORLD_SEED_DEFAULT,
    worldVersion: 0,
    island: holdingAt(SPAWN_POS),
    nextId: 1,
  };
}

export function newGame(pieces: PieceSource = grantTablePieceSource): GameState {
  return { island: newIsland(pieces), sea: newSea() };
}

export const validateSea: ValidateSeaFn = (state, cmd) => {
  const mover = state.sea.island;
  switch (cmd.kind) {
    case 'setCourse': {
      const to = clampToTravel(cmd.target);
      const from = positionAt(mover, state.island.time);
      const quote = zeroQuote();
      const plan = planCourse(from, to, capacity(state.island.tiles).islandSize, IDENTITY_MODIFIERS, state.island.time);
      quote.durationMs = plan.legs[0].tEnd - plan.departAt;
      if (dist(to, from) < MOVE_EPSILON_U) return { ok: false, reason: { code: 'alreadyThere' }, quote };
      if (mover.state === 'underway' && dist(to, destinationOf(mover)) < MOVE_EPSILON_U) {
        return { ok: false, reason: { code: 'alreadyThere' }, quote };
      }
      return { ok: true, quote };
    }
    case 'stop':
      if (mover.state === 'holding') return { ok: false, reason: { code: 'notUnderway' }, quote: null };
      return { ok: true, quote: zeroQuote() };
  }
};

export const applySea: ApplySeaFn = (state, cmd, now) => {
  if (state.island.time !== now) throw new Error('applySea: island.time !== now');
  const verdict = validateSea(state, cmd);
  if (!verdict.ok) throw new Error(`applySea: invalid command (${verdict.reason.code})`);

  const mover = state.sea.island;
  const here = positionAt(mover, now);
  switch (cmd.kind) {
    case 'setCourse': {
      const course = planCourse(here, cmd.target, capacity(state.island.tiles).islandSize, IDENTITY_MODIFIERS, now);
      // Leaving a hold pauses a started placement; a redirect leaves the queue as it is.
      const island = mover.state === 'holding' ? pausePlaceHead(state.island, now) : state.island;
      return { island, sea: { ...state.sea, island: course } };
    }
    case 'stop':
      return {
        island: resumePlaceHead(state.island, now),
        sea: { ...state.sea, island: holdingAt(here) },
      };
  }
};

/** The `departed` / `stopped` event a sea command produced (`after` is applySea's result). */
export function seaEventOf(cmd: { kind: 'setCourse' | 'stop' }, before: GameState, after: GameState, now: GameMs): SeaEvent {
  if (cmd.kind === 'stop') return { kind: 'stopped', at: now, pos: after.sea.island.pos };
  const m = after.sea.island;
  return { kind: 'departed', at: now, from: m.path[0], to: m.path[m.path.length - 1], eta: etaOf(m) as GameMs };
}

export function createAdvanceGame(pieces: PieceSource): AdvanceGameFn {
  const advance = createAdvance(pieces);
  return (state, dtMs) => {
    if (!Number.isInteger(dtMs) || dtMs < 0) {
      throw new Error('advanceGame: dtMs must be a non-negative integer');
    }
    const events: GameEvent[] = [];
    let island: IslandState = state.island;
    let sea = state.sea;
    const end = island.time + dtMs;

    const mover = sea.island;
    const tArrive = etaOf(mover);
    if (mover.state === 'underway' && tArrive !== null && tArrive <= end) {
      // Voyage up to the arrival, then the rest holding. An overdue arrival (a foreign save)
      // arrives at once, at the current time.
      const at = Math.max(tArrive, island.time);
      const leg = advance(island, at - island.time, { underway: true, modifiers: IDENTITY_MODIFIERS });
      events.push(...leg.events);
      const pos: Vec2 = destinationOf(mover);
      island = resumePlaceHead(leg.state, at);
      sea = { ...sea, island: holdingAt(pos) };
      events.push({ kind: 'arrived', at, pos });
    }

    const tail = advance(island, end - island.time, {
      underway: sea.island.state === 'underway',
      modifiers: IDENTITY_MODIFIERS,
    });
    events.push(...tail.events);
    return { state: { island: tail.state, sea }, events };
  };
}

export const advanceGame: AdvanceGameFn = createAdvanceGame(grantTablePieceSource);
