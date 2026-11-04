// Covers the costtime.ts derived helpers: durationMs, demolishMs, investedThrough and
// demolishRefund.
import { describe, expect, it } from 'vitest';
import { RESOURCES } from '../../src/core/types';
import {
  costAt,
  demolishMs,
  demolishRefund,
  durationMs,
  investedThrough,
  secondsAt,
} from '../../src/core/costtime';

describe('durationMs', () => {
  it('= round(seconds) * 1000', () => {
    expect(durationMs('lumberjack', 1)).toBe(280_000);
    expect(durationMs('mainhouse', 5)).toBe(592_000);
  });
});

describe('demolishMs', () => {
  it('= 750 * secondsAt (75% of the build time, in ms)', () => {
    expect(demolishMs('lumberjack', 1)).toBe(750 * 280);
    expect(demolishMs('lumberjack', 7)).toBe(750 * secondsAt('lumberjack', 7));
  });
});

describe('investedThrough', () => {
  it('sums costAt over every level reached so far', () => {
    const inv = investedThrough('lumberjack', 3);
    const manual = RESOURCES.reduce(
      (acc, r) => {
        acc[r] = costAt('lumberjack', 1)[r] + costAt('lumberjack', 2)[r] + costAt('lumberjack', 3)[r];
        return acc;
      },
      { wood: 0, food: 0, stone: 0, iron: 0 },
    );
    expect(inv).toEqual(manual);
  });

  it('mainhouse sums from L2 (L1 is the never-built seed)', () => {
    const inv = investedThrough('mainhouse', 3);
    const manual = RESOURCES.reduce(
      (acc, r) => {
        acc[r] = costAt('mainhouse', 2)[r] + costAt('mainhouse', 3)[r];
        return acc;
      },
      { wood: 0, food: 0, stone: 0, iron: 0 },
    );
    expect(inv).toEqual(manual);
    // L1 must not be counted: mainhouse L1 costs nothing anyway, but the range matters for
    // every other building where "from" allows an L1 charge.
    expect(investedThrough('mainhouse', 1)).toEqual({ wood: 0, food: 0, stone: 0, iron: 0 });
  });
});

describe('demolishRefund', () => {
  it('= floor(50% of invested) per resource', () => {
    const inv = investedThrough('lumberjack', 3);
    const refund = demolishRefund('lumberjack', 3);
    for (const r of RESOURCES) {
      expect(refund[r]).toBe(Math.floor((inv[r] * 50) / 100));
    }
  });

  it('floors an odd invested amount down rather than rounding', () => {
    // lumberjack stone invested through L9 = 105 (odd);
    // 105 * 50 / 100 = 52.5 -> floor 52, not round 53.
    const inv = investedThrough('lumberjack', 9);
    expect(inv.stone).toBe(105);
    expect(demolishRefund('lumberjack', 9).stone).toBe(52);
  });
});
