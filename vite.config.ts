import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000, target: 'es2022' },
  server: { port: 5173, strictPort: false },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
