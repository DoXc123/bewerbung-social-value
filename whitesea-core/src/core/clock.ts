/**
 * clock.ts — event-stepped `advance` (ONESHOT §3.8): walk from event to event (an active item
 * completing, a resource or population reaching its cap), accruing `rate · dt` fixed units per
 * segment. Integer-exact throughout (RES_SCALE === MS_PER_HOUR), so `advance` is exactly
 * associative for any split of `dt`.
 */
import { BUILD_SLOTS, CATCHUP_TIMESCALE, grantTablePieceSource } from './config';
import { computeProduction } from './economy';
import { IDENTITY_MODIFIERS } from './modifiers';
import { applyCompletion, pausePlaceHead, resumePlaceHead } from './queue';
import { capacity } from './territory';
import { RES_SCALE, RESOURCES } from './types';
import type {
  AdvanceFn, AdvanceResult, Fixed, GameClock, GameMs, IslandConditions, IslandState, PieceSource, ResourceVec,
  SimEvent,
} from './types';

if (BUILD_SLOTS !== 1) {
  throw new Error('clock: only BUILD_SLOTS === 1 is supported');
}

/** ms until `current` (fixed) reaches `capFixed` at `ratePerHour` (== fixed units/ms). null = never. */
function msToCap(current: Fixed, capFixed: number, ratePerHour: number): GameMs | null {
  if (ratePerHour <= 0 || current >= capFixed) return null;
  return Math.ceil((capFixed - current) / ratePerHour);
}

const HOLDING: IslandConditions = { underway: false, modifiers: IDENTITY_MODIFIERS };

/**
 * Whole units per game-hour actually accrued: the production report while holding, and
 * floor(perHour · underwayProductionPct / 100) per resource underway (integer, so the fixed-point
 * accrual — and with it associativity — is untouched).
 */
function effectiveRates(state: IslandState, cond: IslandConditions): ResourceVec {
  const perHour = computeProduction(state.tiles).perHour;
  if (!cond.underway) return perHour;
  const out = {} as ResourceVec;
  for (const r of RESOURCES) out[r] = Math.floor((perHour[r] * cond.modifiers.underwayProductionPct) / 100);
  return out;
}

function accrueSegment(state: IslandState, ms: GameMs, events: SimEvent[], cond: IslandConditions): IslandState {
  const at = state.time + ms;
  if (ms === 0) return state;

  const rates = effectiveRates(state, cond);
  const cap = capacity(state.tiles);
  const storageCapFixed = cap.storage * RES_SCALE;
  const populationCapFixed = cap.populationCap * RES_SCALE;

  const treasury = { ...state.treasury };
  for (const r of RESOURCES) {
    const before = treasury[r];
    const rate = rates[r];
    let after = before + rate * ms;
    const wasAtCap = before >= storageCapFixed;
    if (after >= storageCapFixed) after = storageCapFixed;
    treasury[r] = after;
    if (!wasAtCap && after >= storageCapFixed && rate > 0) {
      events.push({ kind: 'storageFull', at, resource: r });
    }
  }

  const beforePop = state.population;
  const popRate = cap.populationPerHour;
  let afterPop = beforePop + popRate * ms;
  const wasPopAtCap = beforePop >= populationCapFixed;
  if (afterPop >= populationCapFixed) afterPop = populationCapFixed;
  if (!wasPopAtCap && afterPop >= populationCapFixed && popRate > 0) {
    events.push({ kind: 'populationFull', at });
  }

  return { ...state, treasury, population: afterPop, time: at };
}

function completeActive(
  state: IslandState,
  pieces: PieceSource,
  events: SimEvent[],
  cond: IslandConditions,
): IslandState {
  const item = state.queue[0];
  const { state: afterCompletion, piecesGranted, piecesLost } = applyCompletion(state, item, pieces);
  events.push({ kind: 'completed', at: state.time, item });
  if (piecesGranted && item.kind === 'upgrade') {
    events.push({ kind: 'piecesGranted', at: state.time, pieces: piecesGranted, townHallLevel: item.level });
  }
  if (piecesLost) events.push({ kind: 'piecesLost', at: state.time, pieces: piecesLost });

  let queue = afterCompletion.queue.slice(1);
  if (queue.length > 0) {
    const started = { ...queue[0], startedAt: state.time };
    // S3a: a placement that starts while underway starts paused.
    const next = cond.underway && started.kind === 'place' ? { ...started, pausedAt: state.time } : started;
    queue = [next, ...queue.slice(1)];
    events.push({ kind: 'started', at: state.time, item: next });
  }
  return { ...afterCompletion, queue };
}

export function createAdvance(pieces: PieceSource): AdvanceFn {
  return (state: IslandState, dtMs: GameMs, cond: IslandConditions = HOLDING): AdvanceResult => {
    if (!Number.isInteger(dtMs) || dtMs < 0) {
      throw new Error('advance: dtMs must be a non-negative integer');
    }

    let cur = state;
    let remaining = dtMs;
    const events: SimEvent[] = [];

    while (remaining > 0) {
      // S3a: a `place` head never runs underway (paused at once if it began unpaused, e.g. queued
      // or promoted by a cancel while underway) and a paused one is released once holding.
      cur = cond.underway ? pausePlaceHead(cur, cur.time) : resumePlaceHead(cur, cur.time);

      const rates = effectiveRates(cur, cond);
      const cap = capacity(cur.tiles);
      const storageCapFixed = cap.storage * RES_SCALE;
      const populationCapFixed = cap.populationCap * RES_SCALE;

      let nextDelta = remaining;
      for (const r of RESOURCES) {
        const d = msToCap(cur.treasury[r], storageCapFixed, rates[r]);
        if (d !== null && d < nextDelta) nextDelta = d;
      }
      const popDelta = msToCap(cur.population, populationCapFixed, cap.populationPerHour);
      if (popDelta !== null && popDelta < nextDelta) nextDelta = popDelta;

      const active = cur.queue[0];
      if (active && active.startedAt !== null && !(active.kind === 'place' && active.pausedAt !== undefined)) {
        let completionDelta = active.startedAt + active.durationMs - cur.time;
        if (completionDelta < 0) completionDelta = 0;
        if (completionDelta < nextDelta) nextDelta = completionDelta;
      }

      cur = accrueSegment(cur, nextDelta, events, cond);
      remaining -= nextDelta;

      const stillActive = cur.queue[0];
      const paused = stillActive?.kind === 'place' && stillActive.pausedAt !== undefined;
      // `<=`, not `===`: a head that is already overdue (a hand-edited or foreign save; the shape
      // check doesn't validate queue items) completes now instead of stalling every accrual.
      if (stillActive && !paused && stillActive.startedAt !== null && stillActive.startedAt + stillActive.durationMs <= cur.time) {
        cur = completeActive(cur, pieces, events, cond);
      } else if (nextDelta === 0) {
        // Nothing was actually due this instant (guards against a stalled loop; unreachable in
        // practice since a zero delta only arises from a completion, handled above).
        break;
      }
    }

    return { state: cur, events };
  };
}

export const advance: AdvanceFn = createAdvance(grantTablePieceSource);

export function createClock(timescale = 1): GameClock {
  let remainderMs = 0;
  const clock: GameClock = {
    timescale,
    tick(realDtMs: number): GameMs {
      const gameMs = realDtMs * clock.timescale + remainderMs;
      const whole = Math.floor(gameMs);
      remainderMs = gameMs - whole;
      return whole;
    },
    catchUp(wallElapsedMs: number): GameMs {
      return Math.floor(wallElapsedMs * CATCHUP_TIMESCALE);
    },
  };
  return clock;
}
