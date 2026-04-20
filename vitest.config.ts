import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The cloud tests mock global.fetch; happy-dom/jsdom are overkill.
    environment: 'node',
    // Show full assertion diffs, not truncated object dumps.
    typecheck: { enabled: false },
  },
});
