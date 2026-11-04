import { defineConfig } from 'vitest/config';

// Node environment only: no jsdom/happy-dom is pinned, so UI and render tests
// cover pure logic (geometry, reducers, helpers), never a live DOM or WebGL.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // the geometry-heavy render tests (relief, picking, buildings) run 2–3 s alone; under the full
    // parallel suite they can pass 5 s
    testTimeout: 20_000,
  },
});
