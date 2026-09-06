// @ts-check
import { defineConfig, globalIgnores } from 'eslint/config';
import eslintJavaScript from '@eslint/js';
import typescriptESLint from 'typescript-eslint';

export default defineConfig(
  globalIgnores([
    '**/node_modules/**',
    '**/outputs/**',
    '**/.wrangler/**',
    '**/.turbo/**',
    '**/coverage/**',
    '**/worker-configuration.d.ts',
  ]),
  eslintJavaScript.configs.recommended,
  typescriptESLint.configs.strictTypeChecked,
  typescriptESLint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CLAUDE.md: `||` 대신 `??` 사용
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [typescriptESLint.configs.disableTypeChecked],
  },
  {
    // 테스트에서 mock/JSON 응답을 다룰 때의 타입 마찰은 허용한다
    files: ['**/tests/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },
);
