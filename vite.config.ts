import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        harness: 'tests/harness.html',
      },
    },
  },
});
