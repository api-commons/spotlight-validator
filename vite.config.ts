import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Static SPA served from a custom domain (validator.spotlight-rules.com), so base '/'.
export default defineConfig({
  base: '/',
  plugins: [
    nodePolyfills({
      // The Spotlight (Spectral) engine pulls in a few Node built-ins.
      globals: { process: true, Buffer: true },
    }),
  ],
  worker: { format: 'es' },
  build: { target: 'es2020', sourcemap: false },
});
