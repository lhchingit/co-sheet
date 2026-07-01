// Flat ESLint config (ESLint v9+).
//
// The codebase has two distinct runtimes with different globals and module
// systems, so it needs two blocks:
//
//   * Server / tooling — ESM ("type":"module"), Node globals. Covers server.js,
//     services/, db/, tests/ and loadtest/.
//   * Browser UI — public/*.js are loaded as CLASSIC <script> tags (see the
//     <script src> list in private/index.html), NOT modules. They share a single
//     global scope and reference each other's top-level functions, so they use
//     `sourceType: script` with browser globals. Cross-file globals would trip
//     `no-undef`, so it's disabled for this block (a bundler/module system would
//     be the real fix; that's out of scope for "make lint runnable").
//
// Run with: npm run lint  (or `npm run lint:fix` to autofix).
import js from '@eslint/js';
import globals from 'globals';

export default [
  // Never lint build output, deps, or vendored assets.
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'public/styles-*.css',
      'docs/**',
      'images/**',
    ],
  },

  js.configs.recommended,

  // Project-wide rule tweaks (apply to every block below).
  {
    rules: {
      // Empty `catch {}` is a deliberate idiom throughout — best-effort calls
      // (localStorage, DOM shims) whose failure is intentionally ignored.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Server-side + tooling: Node, ESM. Note tests include a .mjs harness.
  {
    files: ['server.js', 'services/**/*.js', 'db/**/*.js', 'tests/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Signal intent: allow deliberately-unused args prefixed with _ (e.g. Express
      // (req, res, next) middleware signatures) and caught errors we don't inspect.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // k6 load-test scripts: ESM modules run by the k6 runtime (NOT Node), which
  // injects its own globals (__ENV, __VU, __ITER) and provides console.
  {
    files: ['loadtest/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,   // k6 provides console, setTimeout, etc.
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // Browser UI: classic scripts sharing one global scope.
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser },
    },
    rules: {
      // public/*.js expose and consume each other's top-level functions as browser
      // globals; without a module system that's not something no-undef can see.
      'no-undef': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
