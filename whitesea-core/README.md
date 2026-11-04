# whitesea-core

The pure simulation core of **WhiteSea's island mode**, extracted from a private
project: a hex-grid production puzzle (build, upgrade, demolish on a queue; resources
accrue over time; the island can also sail across a sea). About 3,000 lines of
TypeScript in `src/core/` and 19 test files (227 tests) in `tests/core/`.

There is no UI, no rendering and no three.js here. The core is headless: plain
types and pure functions. In the full project, `game/`, `render/` and `ui/` sit
on top of it and are not part of this extract.

**Status: work in progress.** WhiteSea is not finished: it is a game still in design and build, and this
is its engine layer as it stands, not a released product. Some values are marked provisional in the code
comments, and the tests pin what exists today, not a final design.

**TypeScript, no Node.js APIs.** Everything in `src/` is plain TypeScript (`strict: true`) with no
runtime dependencies and no `node:` imports. Node.js is only the tooling that runs `tsc` and `vitest`.

This is a copy without git history. The source repo is private.

## Run

```bash
npm ci
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest run, Node environment
```

Verified on Node 22.22.1: `tsc` clean, 19 test files, 227 tests passing in about 6 s.
There are no runtime dependencies. `package.json` lists only `typescript`, `vite`
and `vitest` as dev dependencies.

## What is in here

| Path | What it is |
|---|---|
| `src/core/types.ts` | The interface contract: every shared type and function signature |
| `src/core/config.ts` | Every provisional game number in one file |
| `src/core/hex.ts`, `layout.ts`, `mapid.ts` | Hex maths, layout to tiles, the MapID layout codec |
| `src/core/catalog.ts`, `gates.ts`, `costtime.ts` | Building roster, unlock gates, cost and build-time curves |
| `src/core/economy.ts`, `territory.ts` | Production, capacity, connectivity, buildable cells |
| `src/core/queue.ts`, `sim.ts`, `clock.ts` | Build queue, the `project`/`validate`/`apply` commands, event-stepped `advance` |
| `src/core/world/` | The sailing island: `mover.ts` (path as a function of time), `speed.ts` |
| `src/core/game.ts`, `save.ts` | Island + sea combined (`advanceGame`), versioned JSON saves |
| `src/game/fixtures.ts`, `away.ts` | A mid-game test island and the "while you were away" summary. Both import only from `core/` |
| `tests/core/` | The core test suite |

## Architecture

- **State in, state out.** `validate(state, command)` returns a `Verdict`,
  `apply(state, command, now)` returns a new state, and `advance(state, dtMs)` returns a
  new state plus the events that happened (`sim.ts`, `clock.ts`). Nothing mutates.
- **Commands are checked against the right state.** `sim.ts` validates timed commands
  (build, upgrade, demolish, place terrain) against the *projected* state, meaning the
  queue run to completion. Instant commands (remove terrain, cancel) validate against the
  *actual* state and are refused as `busy` if replaying the queue on the result would fail.
- **The island and the sea advance together.** `advanceGame` (`game.ts`) splits the
  island's `advance` at every sea event (an arrival), so production at the reduced
  underway rate and the paused placement queue stay exact.
- **The island's position is a function.** `positionAt(mover, t)` (`world/mover.ts`) is
  computed from a timestamped path rather than stepped, which is why offline catch-up
  needs no special case.

## Decisions and why

1. **Integer fixed-point instead of floating point.** `RES_SCALE === MS_PER_HOUR`
   (`types.ts`), so a rate in whole units per hour accrues as an integer per millisecond.
   `advance` is then exactly associative for any split of the time span (`clock.ts`
   header). `costtime.ts` makes the same choice for the cost formula, so costs are identical on
   every platform.
2. **Purity is a test, not a convention.** `tests/core/purity.test.ts` reads every
   `src/core/**/*.ts` file as raw text, strips comments, and fails on `three`, `window`,
   `document`, `Date.now`, `new Date`, `Math.random`, `performance.now`, `localStorage`,
   or an import from outside `core/`. Time is passed in as `now`, and randomness comes in
   through an injected `PieceSource` (`createAdvance(pieces)` in `clock.ts`).
3. **The queue logic has one owner.** `queue.ts` holds the FIFO rules, the effect a
   completed item has on tiles and treasury, and queue replay. `sim.ts` (commands) and
   `clock.ts` (time) both call it, so the two cannot disagree about what a completion does.
4. **Untrusted input returns a `Result`, and saves are versioned.** `decodeMapId` and
   `deserialize*` return `Result<T>` (`types.ts`) and do not throw. `mapid.ts` never
   substitutes a seed map for a bad length and never clamps an out-of-range level.
   `save.ts` is schema-versioned (`GAME_SAVE_VERSION = 2`) with a migration table, and
   never touches storage: the caller owns `localStorage`.
5. **The type contract was written first.** The header of `types.ts` marks it as frozen
   once published: implementers build against it and report a wrong contract instead of
   editing it. That is how the core could be built as separate tasks in parallel.

## Tests

- **Associativity, property-style.** `advance.test.ts` and `s3a-assoc.test.ts` check
  `advance(s, a+b)` equals `advance(advance(s,a), b)` over many random reachable states
  and random split points. Splits are chosen exactly on a completion, on a storage-full
  transition, and on a sea arrival. Randomness comes from a seeded generator (`mulberry32`),
  so failures reproduce. One test checks that a 30-hour voyage in one call equals the same
  span in 1-hour steps.
- **Rules pinned.** `economy.pins.test.ts`, `gates.test.ts`, `territory.test.ts`,
  `sim.test.ts`, `s0.test.ts` and `s3a-game.test.ts` pin production, unlock gates,
  territory and command verdicts.
- **Round trips and codecs.** `mapid.test.ts`, `save.test.ts`, `s3a-save.test.ts`.
- **Purity.** `purity.test.ts` (see decision 2).

## Held out of this extract, and known limits

- **The cost and build-time curves are placeholders.** The formulas in `costtime.ts` and
  the cost rows in `catalog.ts` are simple numbers written for this extract, not the
  values the private build uses, and are not tuned. `costtime.derived.test.ts` pins the
  derived helpers against them.
- **Comments point at internal planning documents** (`ONESHOT §…`, `PLAN-open-sea`,
  `DECISIONS`, `specs/`) that are not included.
- **Every number in `config.ts` is provisional.** The header says so.
- **`BUILD_SLOTS` must be 1.** `clock.ts` throws on import otherwise.
- **The island save v1 migration table is empty** (`migrate` in `save.ts`). Only the
  version 2 game save has migrations.
- **Tests run in Node only.** `vitest.config.ts` pins `environment: 'node'`, so there are
  no DOM or WebGL tests in this extract.

## Relevance: strict TypeScript, tests, keep-it-simple

- **Strict TypeScript.** `tsconfig.json` has `"strict": true`. The public surface is
  typed function signatures (`ValidateFn`, `ApplyFn`, `AdvanceFn`, ...) and discriminated
  unions for commands and verdicts.
- **Tests.** About 2,900 lines of tests against about 3,000 lines of source, including the
  property-style checks above.
- **Keep it simple.** No runtime dependencies and no framework: plain functions over plain data.
