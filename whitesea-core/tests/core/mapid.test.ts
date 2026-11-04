// W2b acceptance 7: MapID round-trip property + fixed fixtures + every decoder error case.
import { describe, expect, it } from 'vitest';
import { ALL_DEFS } from '../../src/core/catalog';
import { decodeMapId, encodeMapId } from '../../src/core/mapid';
import type { Layout, TerrainId } from '../../src/core/types';
import { FIXTURE_MIDGAME } from '../../src/game/fixtures';

/** Small deterministic PRNG (mulberry32) — never Math.random (ONESHOT §4 purity). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sortLayout(layout: Layout): Layout {
  return [...layout].sort((a, b) => a.r - b.r || a.q - b.q);
}

/** A random legal layout: no duplicate cells, every building on its catalog terrain, levels in range. */
function randomLayout(rng: () => number, count: number): Layout {
  const seen = new Set<string>();
  const layout: Layout = [];
  while (layout.length < count) {
    const q = Math.floor(rng() * 52) - 26;
    const r = Math.floor(rng() * 52) - 26;
    const key = `${q},${r}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const terrain: TerrainId = rng() < 0.5 ? 'land' : 'mountain';
    if (rng() < 0.3) {
      layout.push({ q, r, terrain, building: null, level: 0 });
      continue;
    }
    const candidates = ALL_DEFS.filter((d) => d.terrain === terrain);
    const def = candidates[Math.floor(rng() * candidates.length)];
    const level = 1 + Math.floor(rng() * def.maxLevel);
    layout.push({ q, r, terrain, building: def.id, level });
  }
  return layout;
}

describe('mapid', () => {
  it('round-trips random legal layouts and stays byte-stable', () => {
    const rng = mulberry32(20260924);
    for (let trial = 0; trial < 60; trial++) {
      const layout = randomLayout(rng, 1 + Math.floor(rng() * 40));
      const code = encodeMapId(layout);
      const decoded = decodeMapId(code);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(decoded.value).toEqual(sortLayout(layout));
      // Re-encoding the decoded layout reproduces the exact same code (byte-stable).
      expect(encodeMapId(decoded.value)).toBe(code);
    }
  });

  it('encodes FIXTURE_MIDGAME to its pinned code and decodes back equal', () => {
    const PINNED_CODE =
      '1aWMAbWMAcWiBdWqBeWqBaXMAbXgCcXqBdXSHeXqBaYMAbYiBcYqBdYqBeYiBYZkFZZfBaZfBbZWFcZOHdZiBeZsBWafBXafBYafBZafBaaTHbaJEcaJBdaLAeafBWbfBXbJHYbfBZbHCabLAbbwBcbwBdbbDWcfBXcfBYcLAZcwBacwBbcFHccwBWdfBXdLAYdVCZdwBadwBbdwBZewB';
    const code = encodeMapId(FIXTURE_MIDGAME);
    expect(code).toBe(PINNED_CODE);
    const decoded = decodeMapId(code);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value).toEqual(sortLayout(FIXTURE_MIDGAME));
  });

  it('errors on bad length', () => {
    const r = decodeMapId('1AB');
    expect(r.ok).toBe(false);
  });

  it('errors on bad version', () => {
    const r = decodeMapId('9LLLA');
    expect(r.ok).toBe(false);
  });

  it('errors on an unknown char', () => {
    const r = decodeMapId('1LL0A');
    expect(r.ok).toBe(false);
  });

  it('errors on an unknown type char', () => {
    const r = decodeMapId('1AAZA');
    expect(r.ok).toBe(false);
  });

  it('errors on bare terrain with a non-zero level', () => {
    // land at (0,0), typeChar 'L', levelChar 'B' (=1) — bare terrain must be level 0.
    const r = decodeMapId('1' + 'ZZ' + 'L' + 'B');
    expect(r.ok).toBe(false);
  });

  it('errors on a field at level 0', () => {
    // forest ('f') at level 0 ('A') — fields must be level 1.
    const r = decodeMapId('1' + 'ZZ' + 'f' + 'A');
    expect(r.ok).toBe(false);
  });

  it('errors on a field above its max level', () => {
    // forest ('f') at level 2 ('C') — forest maxLevel is 1.
    const r = decodeMapId('1' + 'ZZ' + 'f' + 'C');
    expect(r.ok).toBe(false);
  });

  it('errors on a building below level 1', () => {
    // mainhouse ('T') at level 0 ('A').
    const r = decodeMapId('1' + 'ZZ' + 'T' + 'A');
    expect(r.ok).toBe(false);
  });

  it('errors on a building above its max level', () => {
    // mainhouse ('T') maxLevel 25; level 26 would be digit 26 = 'a'.
    const r = decodeMapId('1' + 'ZZ' + 'T' + 'a');
    expect(r.ok).toBe(false);
  });

  it('errors on a duplicate cell', () => {
    const rec = 'ZZ' + 'L' + 'A';
    const r = decodeMapId('1' + rec + rec);
    expect(r.ok).toBe(false);
  });

  it('decodes an empty layout from the bare version char', () => {
    const r = decodeMapId('1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual([]);
  });
});
