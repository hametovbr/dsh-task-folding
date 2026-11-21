import js from '@eslint/js'
import globals from 'globals'

/**
 * The host-package import boundary (docs/10 §7, §17): a `@deepseek-ai/*` package may be imported
 * only from `host/ports/**`, the one layer that owns a host contract. `host/ports/compaction-shim.js`
 * is the only file that resolves compaction internals; the summarizer that mentions
 * `@deepseek-ai/dsh-llm` lives at `host/ports/llm.js`, and the package loader lives at
 * `host/ports/host-services.js`, so both are already inside the allowed directory.
 *
 * Type-only imports need no allowlist: this is a JavaScript codebase, so a type-only reference is a
 * JSDoc `import('...')` comment, which is erased and which this rule cannot see (and the pure
 * modules only typedef the shapes they cannot import).
 *
 * To allow one more file, add it to the `ignores` list of the boundary config below — deliberately
 * a visible edit, not a silent exception.
 */
const HOST_PACKAGE_IMPORT = {
  group: ['@deepseek-ai/*'],
  message:
    'Only host/ports/** may import a @deepseek-ai host package; put the boundary behind a port (docs/10 §7).',
}

export default [
  { ignores: ['node_modules/', 'coverage/', 'm0/', '.tmp/', '.m2-scratch/', '.m3-scratch/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.js'],
    ignores: ['host/ports/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [HOST_PACKAGE_IMPORT] }],
    },
  },
  {
    files: ['host/domain/projection.js', 'host/domain/cuts.js'],
    rules: {
      'no-restricted-globals': ['error', 'Date', 'process', 'setTimeout', 'setInterval', 'fetch', 'crypto'],
      'no-restricted-properties': ['error', { object: 'Math', property: 'random' }],
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*', 'fs', 'path', 'os'] }, HOST_PACKAGE_IMPORT] },
      ],
    },
  },
]
