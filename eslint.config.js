import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    // Runtime data can contain tens of thousands of JSON/log/image files. It
    // is not source code and must never make `npm run lint` traverse the data
    // directory, desktop cache, release smoke fixtures, or build output.
    ignores: [
      'dist/**',
      'node_modules/**',
      '.theia-*/**',
      '.exe-*/**',
      'release/**',
      'release-bin/**',
      '.npm-cache/**',
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
)
