import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Inline the registration (no separately cached registerSW.js) and use a
      // worker filename the Cloudflare edge has never cached; the origin now
      // sends no-store for it so this cannot recur.
      injectRegister: 'inline',
      filename: 'service-worker.js',
      includeAssets: ['todos-hinge.svg', 'todos-hinge-favicon.png', 'todos-hinge-apple.png', 'robots.txt'],
      manifest: {
        name: 'Todos',
        short_name: 'Todos',
        description: 'A personal kanban task board, the same on every device.',
        theme_color: '#007eea',
        background_color: '#cceeff',
        display: 'standalone',
        orientation: 'portrait',
        // §14.2 Web Share Target (GET): shared text lands in ?text= and App turns it into the add intent.
        share_target: {
          action: '/',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
        icons: [
          // Renamed with each redesign so installed desktop apps notice the change and refresh their icon.
          { src: 'todos-hinge-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'todos-hinge-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'todos-hinge-1024.png', sizes: '1024x1024', type: 'image/png', purpose: 'any' },
          { src: 'todos-hinge-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
       },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        // Attachment files the device has shown stay viewable offline (public/sw-files.js, ~100 MB, cache-first).
        importScripts: ['sw-files.js'],
        navigateFallbackDenylist: [/^\/kanban\//, /^\/agents/, /^\/view\//],
        clientsClaim: true,
        skipWaiting: true,
       },
     }),
   ],
  server: { host: true, port: 5173 },
  build: { target: 'es2020', outDir: 'dist' },
});
