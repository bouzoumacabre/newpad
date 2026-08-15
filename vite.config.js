import { defineConfig } from 'vite';
import legacy from '@vitejs/plugin-legacy';

// Base relative ('./') pour fonctionner quel que soit le sous-chemin GitHub
// Pages (https://<user>.github.io/<repo>/) et dans le navigateur intégré FiveM.
export default defineConfig({
  base: './',
  plugins: [
    legacy({
      targets: ['defaults', 'Chrome >= 69', 'not IE 11'],
      modernPolyfills: true,
    }),
  ],
  build: {
    target: 'es2017',
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
