import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  // .claude/ holds git worktrees — full copies of this repository. Flat
  // config does not skip dot-directories the way eslintrc did, so without
  // this ESLint lints the project once per worktree: minutes of work, and
  // enough heap to OOM. It is gitignored, so only local runs ever saw it.
  { ignores: ['out/**', 'release/**', 'node_modules/**', 'drizzle/**', '.claude/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Unused args are fine when they document a callback's signature.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      // `void promise` is the intentional way to fire and forget here.
      '@typescript-eslint/no-floating-promises': 'error'
    }
  },

  // Main / preload / MCP: Node globals.
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/core/**/*.ts', 'src/mcp/**/*.ts'],
    languageOptions: { globals: globals.node }
  },

  // Renderer: browser globals plus the React hooks rules.
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules
  },

  // node:test's `test()` returns a promise that is not meant to be awaited.
  {
    files: ['**/__tests__/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' }
  },

  // Build scripts, config files and the published npm launcher run outside the
  // typed program. `packaging/npm/bin` is shipped as-is rather than built, so
  // it is source in a directory tsc has no reason to know about.
  {
    files: ['*.config.{js,ts}', 'eslint.config.js', 'scripts/**/*.mjs', 'packaging/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: false, project: null }
    }
  }
)
