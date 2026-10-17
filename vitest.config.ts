import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
      '@': path.resolve(import.meta.dirname, 'src/renderer'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('2.0.0-test'),
  },
  test: {
    environment: 'jsdom',
    include: [
      // 已归档的旧前端测试（源码在 旧前端/）与新前端测试（tests/desktop）共用同一套配置。
      '旧前端/tests/components/**/*.test.tsx',
      '旧前端/tests/lib/**/*.test.ts',
      'tests/desktop/**/*.test.ts',
      'tests/desktop/**/*.test.tsx',
    ],
    setupFiles: ['./旧前端/tests/components/setup.ts'],
    restoreMocks: true,
  },
});
