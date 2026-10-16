/**
 * JournalStorePort 契约套件：写一次、跑多次。阶段一对内存实现运行，阶段二对 SQLite 实现复用。
 * 以工厂 `() => JournalStorePort` 注入被测实现，覆盖 run/actor/node/event 的写入-读取语义与隔离性。
 *
 * 之所以住在 src/（而非 tests/）：SQLite 实现在 @zcode/adapters 里，需要经
 * `@zcode/dynamic-workflow/testing` 子路径导入同一份套件。vitest 仍是 devDependency——
 * 本文件只在消费方的测试进程里执行，不进入任何运行时路径。
 *
 * 用例按主题分住兄弟模块（journal-contract-runs / -script / -nodes / -artifacts / -events / -isolation / -reads.ts，
 * 共用夹具在 journal-contract-helpers.ts；拆分原因：oxlint max-lines 上限 400 行）。本文件只保留
 * 入口：同一个 describe 里按拆分前的顺序依次登记各组用例，套件的分组与顺序逐字不变。
 */

import { describe } from "vitest";
import type { JournalStorePort } from "../engine/index.js";
import { registerRunCases } from "./journal-contract-runs.js";
import { registerScriptCases } from "./journal-contract-script.js";
import { registerNodeCases } from "./journal-contract-nodes.js";
import { registerArtifactCases } from "./journal-contract-artifacts.js";
import { registerEventCases } from "./journal-contract-events.js";
import { registerIsolationCases } from "./journal-contract-isolation.js";
import { registerReadCases } from "./journal-contract-reads.js";

export function runJournalStoreContract(factory: () => JournalStorePort): void {
  describe("JournalStorePort contract", () => {
    registerRunCases(factory);
    registerScriptCases(factory);
    registerNodeCases(factory);
    registerArtifactCases(factory);
    registerEventCases(factory);
    registerIsolationCases(factory);
    registerReadCases(factory);
  });
}
