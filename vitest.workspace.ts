import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/backend/*',
  {
    test: {
      coverage: {
        provider: 'v8',
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  }
]);
