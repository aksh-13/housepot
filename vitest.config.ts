import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54329/housepot_test",
    },
  },
});
