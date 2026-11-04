/**
 * queue.ts — build-queue mechanics shared by sim.ts (validate/apply/project) and clock.ts
 * (advance): FIFO push/cancel, the structural "completion" effect a queue item has on tiles /
 * highWater / pieces / treasury, and queue-replay (used to refuse instant commands with `busy`
 * when they would invalidate queued work).
 */
import { CANCEL_REFUND_PCT, MAX_QUEUE } from './config';
import { demolishRefund } from './costtime';
import { anyPieces, storedPieces, truncateGrant } from './pieces';
import { completeTiles, storageCap } from './territory';
import { RES_SCALE, RESOURCES } from './types';
import type { Fixed, GameMs, IslandState, PieceSource, QueueItem, Resource, TerrainId } from './types';

export function isQueueFull(queue: QueueItem[]): boolean {
  return queue.length >= MAX_QUEUE;
}

/** Append a fully-formed item (id/paid/durationMs/startedAt already decided by the caller). */
export function pushItem(state: IslandState, item: QueueItem): IslandState {
  return { ...state, queue: [...state.queue, item] };
}

function clampTreasuryToCap(treasury: Record<Resource, Fixed>, capWhole: number): Record<Resource, Fixed> {
  const capFixed = capWhole * RES_SCALE;
  const out = { ...treasury };
  for (const r of RESOURCES) {
    if (out[r] > capFixed) out[r] = capFixed;
  }
  return out;
}

/**
 * The structural effect of one queue item completing: build → tile gets the building at L1;
 * upgrade → level bumps, a mainhouse level newly reached grants pieces; demolish → refund
 * (clamped), tile goes bare; place → the tile appears (its piece was taken at enqueue).
 * `highWater` only ever grows. A storage drop (warehouse demolish) clamps the treasury down.
 *
 * A piece grant is truncated to PIECE_CAP (S0.2): stored = pieces in hand + pieces reserved by
 * the `place` items in `state.queue`, so callers pass the queue as it stands when `item`
 * completes (item first, the waiting items after it). `piecesGranted` is what was stored,
 * `piecesLost` the rest (null when nothing was lost). Never mutates the input state.
 */
export function applyCompletion(
  state: IslandState,
  item: QueueItem,
  pieces: PieceSource,
): {
  state: IslandState;
  piecesGranted: Record<TerrainId, number> | null;
  piecesLost: Record<TerrainId, number> | null;
} {
  const tiles = completeTiles(state.tiles, item);
  let treasury = state.treasury;
  let highWater = state.highWater;
  let piecesState = state.pieces;
  let piecesGranted: Record<TerrainId, number> | null = null;
  let piecesLost: Record<TerrainId, number> | null = null;

  if (item.kind === 'build') {
    if ((highWater[item.building] ?? 0) < 1) {
      highWater = { ...highWater, [item.building]: 1 };
    }
  } else if (item.kind === 'upgrade') {
    if ((highWater[item.building] ?? 0) < item.level) {
      highWater = { ...highWater, [item.building]: item.level };
      if (item.building === 'mainhouse' && item.level >= 2) {
        const { kept, lost } = truncateGrant(storedPieces(state), pieces.onTownHallLevel(item.level));
        piecesState = { land: piecesState.land + kept.land, mountain: piecesState.mountain + kept.mountain };
        piecesGranted = kept;
        if (anyPieces(lost)) piecesLost = lost;
      }
    }
  } else if (item.kind === 'demolish') {
    const refund = demolishRefund(item.building, item.level);
    const added = { ...treasury };
    for (const r of RESOURCES) added[r] = added[r] + refund[r] * RES_SCALE;
    treasury = added;
  }

  treasury = clampTreasuryToCap(treasury, storageCap(tiles));

  return { state: { ...state, tiles, treasury, highWater, pieces: piecesState }, piecesGranted, piecesLost };
}

/**
 * Remove `itemId`, refund `CANCEL_REFUND_PCT` of what it paid (clamped to storage), return a
 * `place` item's reserved piece, and — if it was the active item — start the new head at `now`.
 * Assumes the id exists (validate guards).
 */
export function cancelItem(state: IslandState, itemId: number, now: GameMs): IslandState {
  const idx = state.queue.findIndex((i) => i.id === itemId);
  if (idx === -1) return state;
  const item = state.queue[idx];
  const wasActive = idx === 0 && item.startedAt !== null;

  let treasury = { ...state.treasury };
  for (const r of RESOURCES) {
    treasury[r] = treasury[r] + Math.floor((item.paid[r] * RES_SCALE * CANCEL_REFUND_PCT) / 100);
  }
  treasury = clampTreasuryToCap(treasury, storageCap(state.tiles));

  const pieces =
    item.kind === 'place' ? { ...state.pieces, [item.terrain]: state.pieces[item.terrain] + 1 } : state.pieces;

  let queue = state.queue.filter((i) => i.id !== itemId);
  if (wasActive && queue.length > 0) {
    queue = [{ ...queue[0], startedAt: now }, ...queue.slice(1)];
  }

  return { ...state, treasury, pieces, queue };
}

/**
 * Run `state.queue` to completion in order, as `advance` would: before each item completes, the
 * state's queue is that item and everything after it (so reserved pieces still count toward the
 * cap). `checkItem` (optional) is asked first about each item against the progressively-
 * completed state; the first refusal stops the run with `ok: false`. The returned state has an
 * empty queue.
 */
export function runQueue(
  state: IslandState,
  pieces: PieceSource,
  checkItem?: (projected: IslandState, item: QueueItem) => boolean,
): { ok: boolean; state: IslandState } {
  const queue = state.queue;
  let cur: IslandState = state;
  for (let i = 0; i < queue.length; i++) {
    cur = { ...cur, queue: queue.slice(i) };
    if (checkItem && !checkItem(cur, queue[i])) return { ok: false, state: cur };
    cur = applyCompletion(cur, queue[i], pieces).state;
  }
  return { ok: true, state: { ...cur, queue: [] } };
}

/**
 * Replay `state.queue`, checking each item in turn with `checkItem` against the progressively-
 * completed state. Returns false (→ `busy`) on the first item that no longer checks out. Used
 * to gate instant commands.
 */
export function replayQueue(
  state: IslandState,
  checkItem: (projected: IslandState, item: QueueItem) => boolean,
  pieces: PieceSource,
): boolean {
  return runQueue(state, pieces, checkItem).ok;
}

/**
 * S3a: pause the head if it is a started, still-running `place` (placement only runs while the
 * island holds). `pausedAt` freezes progress at `pausedAt − startedAt`. Idempotent.
 */
export function pausePlaceHead(state: IslandState, at: GameMs): IslandState {
  const head = state.queue[0];
  if (!head || head.kind !== 'place' || head.startedAt === null || head.pausedAt !== undefined) return state;
  return { ...state, queue: [{ ...head, pausedAt: at }, ...state.queue.slice(1)] };
}

/**
 * S3a: resume a paused head at `at` — `startedAt` moves forward by the time spent paused, so the
 * item finishes exactly `remaining` ms later. Idempotent.
 */
export function resumePlaceHead(state: IslandState, at: GameMs): IslandState {
  const head = state.queue[0];
  if (!head || head.kind !== 'place' || head.pausedAt === undefined) return state;
  const { pausedAt, ...rest } = head;
  const resumed: QueueItem = { ...rest, startedAt: head.startedAt === null ? null : head.startedAt + Math.max(0, at - pausedAt) };
  return { ...state, queue: [resumed, ...state.queue.slice(1)] };
}
