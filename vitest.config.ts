import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: {
    alias: {
      '@qline/policy': path.resolve(__dirname, 'packages/policy/src/index.ts'),
      '@qline/ai': path.resolve(__dirname, 'packages/ai/src/index.ts'),
      '@qline/schema': path.resolve(__dirname, 'packages/schema/src/index.ts'),
    },
  },
  test: { testTimeout: 240000, hookTimeout: 120000, fileParallelism: false },
});
