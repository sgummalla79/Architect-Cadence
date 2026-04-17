import { defineConfig } from 'vitest/config';

// Vitest handles TypeScript natively via esbuild. No transformer setup,
// no tsconfig coupling beyond type-awareness. Fast, deterministic.
export default defineConfig({
  test: {
    // Makes `describe`, `test`, `expect`, `beforeEach`, `afterEach` available
    // without explicit imports — keeps existing Jest-style tests unchanged.
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});