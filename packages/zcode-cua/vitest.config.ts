import { defineConfig } from "vitest/config";

// 根单测引用固定项目入口；缺失此文件会在发现公共测试前直接终止。
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "cua-placeholder",
    include: ["test/**/*.test.ts"],
    // 根项目已有普通与串行两组；独立分组避免不同 worker 数使整个单测入口退出。
    maxWorkers: 1,
    sequence: { groupOrder: 2 },
  },
});
