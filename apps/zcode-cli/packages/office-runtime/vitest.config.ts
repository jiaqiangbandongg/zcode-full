import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["*.test.ts", "src/**/*.test.ts", "ui/**/*.test.ts", "scripts/**/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
