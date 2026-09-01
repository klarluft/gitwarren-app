import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/core/db/schema.ts',
  out: './drizzle',
  // Migration files are generated at build time and committed; drizzle-kit does
  // not need to reach the real database to produce them.
  verbose: true,
  strict: true
})
