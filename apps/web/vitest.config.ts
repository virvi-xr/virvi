import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Component tests render .tsx with React 19's automatic runtime (Next's tsconfig says `preserve`)
  esbuild: { jsx: 'automatic' },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
