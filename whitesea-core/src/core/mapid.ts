/**
 * mapid.ts — the MapID layout codec (ONESHOT §3.8 grammar, exact).
 *
 * Strict where the reference format was sloppy: the decoder never
 * substitutes a seed map for a bad length and never clamps an out-of-range level to
 * the building's minimum. Every malformed input is a `Result` error instead.
 */
import { getDef } from './catalog';
import type { BuildingId, DecodeMapIdFn, EncodeMapIdFn, Layout, LayoutRecord, TerrainId } from './types';

const MAPID_VERSION = '1';
/** The MapID window is also the world bound (§3.8): q, r ∈ [−26, 25]. */
const COORD_MIN = -26;
const COORD_MAX = 25;
/** digit offset: qChar = digit(q + COORD_OFFSET), rChar = digit(r + COORD_OFFSET). */
const COORD_OFFSET = 26;

const TERRAIN_CHAR: Record<TerrainId, string> = { land: 'L', mountain: 'M' };

/** Type-char table (ONESHOT §3.8), append-only once shipped. */
const BUILDING_CHAR: Record<BuildingId, string> = {
  mainhouse: 'T',
  villagecentre: 'V',
  warehouse: 'W',
  house: 'H',
  forest: 'f',
  wheatfield: 'w',
  quarry: 'q',
  irondeposit: 'i',
  lumberjack: 'J',
  farm: 'F',
  stonemason: 'S',
  oremine: 'O',
  sawmill: 'k',
  bakery: 'b',
  stonegrindery: 'g',
  ironsmelter: 's',
};

interface TypeEntry {
  terrain: TerrainId;
  /** null = bare terrain (no building). */
  building: BuildingId | null;
}

/** typeChar → decoded meaning. A building char implies its terrain (catalog.ts). */
const CHAR_TYPE: Record<string, TypeEntry> = {};
for (const terrain of Object.keys(TERRAIN_CHAR) as TerrainId[]) {
  CHAR_TYPE[TERRAIN_CHAR[terrain]] = { terrain, building: null };
}
for (const building of Object.keys(BUILDING_CHAR) as BuildingId[]) {
  CHAR_TYPE[BUILDING_CHAR[building]] = { terrain: getDef(building).terrain, building };
}

/** Base-52 digit: A–Z = 0–25, a–z = 26–51. */
function digitToChar(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 51) {
    throw new Error(`mapid: digit out of range: ${n}`);
  }
  return n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(97 + (n - 26));
}

function charToDigit(ch: string): number | null {
  const code = ch.charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97 + 26;
  return null;
}

export const encodeMapId: EncodeMapIdFn = (layout: Layout): string => {
  // Byte-stable: sort by (r, q) regardless of the caller's order.
  const sorted = [...layout].sort((a, b) => a.r - b.r || a.q - b.q);
  let out = MAPID_VERSION;
  for (const rec of sorted) {
    const typeChar = rec.building !== null ? BUILDING_CHAR[rec.building] : TERRAIN_CHAR[rec.terrain];
    out +=
      digitToChar(rec.q + COORD_OFFSET) +
      digitToChar(rec.r + COORD_OFFSET) +
      typeChar +
      digitToChar(rec.level);
  }
  return out;
};

export const decodeMapId: DecodeMapIdFn = (code: string) => {
  if (code.length === 0) {
    return { ok: false, error: 'mapid: empty code (missing version char)' };
  }
  if (code[0] !== MAPID_VERSION) {
    return { ok: false, error: `mapid: unsupported version '${code[0]}'` };
  }
  const body = code.slice(1);
  if (body.length % 4 !== 0) {
    return { ok: false, error: `mapid: bad length (${code.length})` };
  }

  const recordCount = body.length / 4;
  const seen = new Set<string>();
  const records: LayoutRecord[] = [];

  for (let i = 0; i < recordCount; i++) {
    const chunk = body.slice(i * 4, i * 4 + 4);
    const qChar = chunk[0];
    const rChar = chunk[1];
    const typeChar = chunk[2];
    const levelChar = chunk[3];

    const qDigit = charToDigit(qChar);
    const rDigit = charToDigit(rChar);
    const levelDigit = charToDigit(levelChar);
    if (qDigit === null || rDigit === null || levelDigit === null) {
      return { ok: false, error: `mapid: unknown char in record ${i} ('${chunk}')` };
    }

    const type = CHAR_TYPE[typeChar];
    if (!type) {
      return { ok: false, error: `mapid: unknown type char '${typeChar}' in record ${i}` };
    }

    const q = qDigit - COORD_OFFSET;
    const r = rDigit - COORD_OFFSET;
    // The 52-symbol alphabet maps 1:1 onto the window, so this can't fail today — kept as an
    // explicit guard rather than a silent assumption (never substitute, never clamp).
    if (q < COORD_MIN || q > COORD_MAX || r < COORD_MIN || r > COORD_MAX) {
      return { ok: false, error: `mapid: coordinate out of bounds in record ${i} (${q},${r})` };
    }

    const level = levelDigit;
    if (type.building === null) {
      if (level !== 0) {
        return { ok: false, error: `mapid: bare terrain level must be 0 in record ${i} (got ${level})` };
      }
    } else {
      const maxLevel = getDef(type.building).maxLevel;
      if (level < 1 || level > maxLevel) {
        return {
          ok: false,
          error: `mapid: level ${level} out of range for ${type.building} (1..${maxLevel}) in record ${i}`,
        };
      }
    }

    const key = `${q},${r}`;
    if (seen.has(key)) {
      return { ok: false, error: `mapid: duplicate cell (${q},${r}) in record ${i}` };
    }
    seen.add(key);

    records.push({ q, r, terrain: type.terrain, building: type.building, level });
  }

  return { ok: true, value: records };
};
