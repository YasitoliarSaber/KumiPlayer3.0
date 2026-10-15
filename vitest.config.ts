import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('2.0.0-test'),
  },
  test: {
    environment: 'jsdom',
    include: [
      'tests/components/**/*.test.tsx',
      'tests/lib/**/*.test.ts',
      'tests/desktop/**/*.test.ts',
      'tests/desktop/**/*.test.tsx',
    ],
    setupFiles: ['./tests/components/setup.ts'],
    restoreMocks: true,
  },
});
