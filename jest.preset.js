/** Configuration Jest commune : transpilation rapide par SWC, avec la prise en charge des décorateurs NestJS. */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2022',
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  // Les bibliothèques internes sont chargées depuis leurs sources : pas besoin de les compiler pour tester.
  moduleNameMapper: {
    '^@ksp/platform/telemetry$': '<rootDir>/../../libs/platform/src/telemetry/telemetry',
    '^@ksp/(contracts|platform)$': '<rootDir>/../../libs/$1/src',
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/main.ts',
    '!src/tracing.ts',
    '!src/**/generated/**',
  ],
};
