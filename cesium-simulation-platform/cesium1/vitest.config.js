import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{js,ts}'],
    setupFiles: ['./test/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: './coverage',
      exclude: [
        '**/node_modules/**',
        'dist/**',
        'public/**',
        'scripts/**',
        'src/**/*.spec.{js,ts}',
        'src/**/*.test.{js,ts}',
        'src/utils/bench/**'
      ]
    }
  }
})
