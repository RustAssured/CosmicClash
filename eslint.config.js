import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'docs/gallery/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.scratch/**',
      // WJ's reference bundles (prototypes and oracles), kept as delivered
      'uri/**',
      'mouth/**',
      'shared/**',
      'assets/**',
      'tools/uri-bake/**',
      'press/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['tools/**', 'tests/**', 'e2e/**', 'dev/**', '*.config.*', '**/*.test.ts'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
