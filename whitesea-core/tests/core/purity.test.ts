// ONESHOT §4: src/core/** is headless and relay-safe. This test fails if any core module
// imports three, touches the DOM, or reads a clock / randomness.
// Sources are read through Vite's raw glob (no @types/node in the §7 pins).
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob('../../src/core/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Strip comments so documentation may name the forbidden things. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const FORBIDDEN: [string, RegExp][] = [
  ['three import', /from\s+['"]three(\/[^'"]*)?['"]|import\(\s*['"]three/],
  ['window', /\bwindow\b/],
  ['document', /\bdocument\b/],
  ['Date.now()', /\bDate\.now\b/],
  ['new Date()', /\bnew\s+Date\b/],
  ['Math.random()', /\bMath\.random\b/],
  ['performance.now()', /\bperformance\.now\b/],
  ['localStorage', /\blocalStorage\b/],
  ['import from outside core', /from\s+['"]\.\.\//],
];

describe('src/core purity', () => {
  const files = Object.keys(SOURCES);
  it('has modules to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const f of files) {
    it(`${f} is pure`, () => {
      const src = code(SOURCES[f]);
      for (const [what, re] of FORBIDDEN) {
        // core/world/* reaches its siblings with one `../`; two would leave core.
        const pattern = what === 'import from outside core' && f.includes('/core/world/')
          ? /from\s+['"]\.\.\/\.\.\//
          : re;
        expect(pattern.test(src), `${what} in ${f}`).toBe(false);
      }
    });
  }
});
