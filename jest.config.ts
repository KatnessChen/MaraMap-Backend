import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    '**/*.(t|j)s',
    '!**/main.ts',         // Bootstrap entry point
    '!**/*.module.ts',     // NestJS module declarations
  ],
  coverageDirectory: '../coverage',
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],
  coverageThreshold: {
    global: {
      // Initial thresholds for early stage development
      // Gradually increase as more features and tests are added
      lines: 60,
      functions: 60,
      branches: 40,
      statements: 60,
    },
  },
  testEnvironment: 'node',
  reporters: [
    'default',
    [
      'jest-html-reporters',
      {
        publicPath: './test-report/unit',
        filename: 'index.html',
        openReport: false,
        pageTitle: 'MaraMap Unit Test Report',
      },
    ],
    [
      'jest-junit',
      {
        outputDirectory: './test-results/unit',
        outputName: 'junit.xml',
        classNameTemplate: '{classname}',
        titleTemplate: '{title}',
      },
    ],
  ],
};

export default config;
