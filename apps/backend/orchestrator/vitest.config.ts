import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

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
  },
  resolve: {
    alias: {
      "@delegolabs/cache": path.resolve(root, "../../../packages/cache/src/index.ts"),
    },
  },
});

