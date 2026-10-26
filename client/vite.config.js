import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // changeOrigin must stay false: the server's csrfGuard compares the Origin header with Host, and Vite's string shorthand
      // ('/api': 'http://...') turns changeOrigin on, which made every POST/PATCH 403 in development after login.
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: false },
    },
  },
});
