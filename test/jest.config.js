module.exports = {
  rootDir: '..',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFilesAfterEnv: ['<rootDir>/test/helpers/setup.ts'],
  globalSetup: '<rootDir>/test/helpers/global-setup.ts',
  // Concurrency tests want the whole database to themselves.
  maxWorkers: 1,
  testTimeout: 60000,
  verbose: true,
};
