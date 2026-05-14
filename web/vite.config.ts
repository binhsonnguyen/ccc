import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output goes straight into the Go embed source-of-truth.
// `emptyOutDir: true` ensures stale chunks from previous builds are wiped;
// since the embed dir lives outside web/, Vite normally refuses to clear
// it — we explicitly opt in.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../internal/webdev/assets',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    port: 5173,
    // Dev proxy is omitted: the Go server picks a random port at runtime,
    // so there's no static target. MVP relies on production build embed.
  },
});
