import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

export default defineConfig({
    server:{
        allowedHosts: ['stockier-deacon-nonintelligently.ngrok-free.dev'],
        },
  plugins: [svelte()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
