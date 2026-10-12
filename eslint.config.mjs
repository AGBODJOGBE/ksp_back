// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'libs/contracts/src/generated/**',
      'tools/new-service/template/**',
      '**/prisma/migrations/**',
      '**/prisma/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Fichiers de configuration CommonJS (jest, commitlint, scripts) exécutés par Node.
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        module: 'writable',
        exports: 'writable',
        require: 'readonly',
        __dirname: 'readonly',
        process: 'readonly',
      },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      // Indique au linter que NestJS lit les types des constructeurs à l'exécution :
      // un import utilisé pour l'injection ne doit pas devenir « import type ».
      parserOptions: { emitDecoratorMetadata: true, experimentalDecorators: true },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': 'error',
    },
  },
  {
    // Règle d'architecture : le domaine ne dépend d'aucun framework ni de l'infrastructure.
    files: ['services/*/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', '@prisma/*', 'amqplib', '@grpc/*', '@ksp/platform', '@ksp/contracts'],
              message: 'Le domaine reste pur : aucune dépendance technique.',
            },
            {
              group: ['**/infrastructure/**', '**/interfaces/**', '**/application/**'],
              message: "Le domaine ne dépend d'aucune autre couche.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['services/*/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/infrastructure/**', '**/interfaces/**'],
              message: "L'application dépend uniquement du domaine et de ses ports.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.spec.ts', '**/test/**/*.ts', 'tools/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
