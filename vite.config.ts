import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  preview: { host: '0.0.0.0', port: 4173, strictPort: true },
  build: {
    target: 'es2022',
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'three', test: /node_modules\/three/ }] } } },
  },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
