/**
 * SEA 下沙箱子进程的 spawn 策略选择（docs/dynamic-workflow/launch.md「Single-executable builds」）。
 *
 * Bug 根因：harness 缺省 spawn `node --max-old-space-size=… <entry>`。SEA 单文件二进制不解释
 * Node CLI 旗标，这个 token 会落进 CLI 的严格 parseArgs，子进程立刻报错退出——SEA 下每一个
 * dwf run 必然失败。故 SEA 下改传隐藏子命令作为 argsPrefix。
 *
 * 为什么这条测试值得存在：两个方向都会造成静默的生产故障——SEA 下漏传 argsPrefix，run 全灭；
 * 非 SEA 误传 argsPrefix，普通 node 会把子命令名当脚本路径去加载而找不到文件，同样 run 全灭。
 * 默认探针分支（无参调用）在测试进程里必须是 undefined：这就是"普通 node 不许带 argsPrefix"。
 */

import { describe, expect, it } from "vitest";
import { ZCODE_DWF_CHILD_COMMAND } from "@zcode/contracts";
import { dynamicWorkflowChildSpawn } from "../src/app/dynamic-workflow-run-launch.js";

describe("dynamicWorkflowChildSpawn", () => {
  it("SEA 下给出隐藏子命令作为 argsPrefix", () => {
    expect(dynamicWorkflowChildSpawn(true)).toEqual({ argsPrefix: [ZCODE_DWF_CHILD_COMMAND] });
  });

  it("非 SEA 下完全不表态（harness 走缺省的 node <entry> 形状）", () => {
    expect(dynamicWorkflowChildSpawn(false)).toBeUndefined();
  });

  it("默认探针在普通 node 进程里判定为非 SEA", () => {
    expect(dynamicWorkflowChildSpawn()).toBeUndefined();
  });
});
