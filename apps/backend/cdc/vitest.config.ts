import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      statements: 85,
      branches: 85,
      functions: 85,
      lines: 85,
    },
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

