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
  // Netplay determinism (docs/netplay/STEP0.md): the simulation path must give the same bits on every JS engine. Math's
  // transcendentals and `**` are implementation-approximated (V8, SpiderMonkey and JavaScriptCore round differently), so
  // the sim uses DMath (src/contracts/dmath.ts). Render, audio and UI keep Math.
  {
    files: [
      'src/sim/**/*.ts',
      'src/matter/**/*.ts',
      'src/combat/**/*.ts',
      'src/ai/**/*.ts',
      'src/titans/**/*.ts',
      'src/contracts/**/*.ts',
    ],
    ignores: ['**/*.test.ts', 'src/contracts/dmath.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...[
          'sin',
          'cos',
          'tan',
          'asin',
          'acos',
          'atan',
          'atan2',
          'sinh',
          'cosh',
          'tanh',
          'asinh',
          'acosh',
          'atanh',
          'exp',
          'expm1',
          'log',
          'log1p',
          'log2',
          'log10',
          'pow',
          'hypot',
          'cbrt',
        ].map((property) => ({
          object: 'Math',
          property,
          message: `Math.${property} differs between JS engines (netplay desync): use DMath.${property} from '@/contracts/dmath' (docs/netplay/STEP0.md).`,
        })),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "BinaryExpression[operator='**'], AssignmentExpression[operator='**=']",
          message:
            "`**` is Math.pow, which differs between JS engines: use sq(x) or DMath.pow from '@/contracts/dmath' (docs/netplay/STEP0.md).",
        },
      ],
    },
  },
  prettier,
);
