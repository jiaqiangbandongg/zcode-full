import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Bug 修复：root `tsc -b` 会把 composite 产物写进 dist，vitest 默认收集规则曾把
    // dist/test 下的编译副本重复执行（陈旧产物还可能造成误报）。只收集源码测试。
    include: ["test/**/*.test.ts"],
    // 集成用例自身允许等待真实 Supervisor/Core 启动；独立 package 脚本也要与根配置
    // 使用同一上限，避免机器负载高时先被 Vitest 默认 5 秒超时截断。
    hookTimeout: 30_000,
    testTimeout: 30_000,
    // 该 package 的集成用例会真实启动 tsx/Supervisor/Core；独立执行 package 脚本时也要
    // 串行运行，避免 threads 并发启动压力让 ready barrier 偶发超时，同时保留同进程
    // mock 的语义（forks worker 会改变部分 node 模块 mock 的时序）。
    pool: "threads",
    fileParallelism: false,
    maxWorkers: 1,
  },
});
