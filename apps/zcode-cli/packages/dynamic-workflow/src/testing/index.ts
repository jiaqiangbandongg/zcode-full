/**
 * `@zcode/dynamic-workflow/testing`：面向 JournalStorePort 实现方的共享测试资产。
 * 只在消费方的测试进程里执行（vitest 是本包的 devDependency，不进入运行时依赖）。
 */

export { runJournalStoreContract } from "./journal-contract.js";
