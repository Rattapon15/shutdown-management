import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/**', 'public/**', 'uploads/**', 'stitch_machine_shutdown_tracker_web/**'] },
  js.configs.recommended,
  {
    // Server: CommonJS on Node.
    files: ['*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_|^next$' }] },
  },
  {
    // Browser auth bundle: strict TypeScript.
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
  },
);
