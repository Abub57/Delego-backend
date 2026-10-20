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
    environment: "node",
    // Each issuance shells out to the system `openssl` several times. Under a
    // workspace-wide parallel run those spawns compete for CPU with every other
    // package's workers and a single test has been observed taking 57s (against
    // ~2s standalone), so the timeout has to absorb that contention.
    testTimeout: 180000,
    // Run this package's files one at a time: they are almost entirely `openssl`
    // key-generation, and firing several in parallel only adds to the CPU
    // contention that makes each individual spawn slow.
    fileParallelism: false,
  },
});

