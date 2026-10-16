// ============================================================
// 就地生效的修订在转写里的那一行（docs/dynamic-workflow/concurrency.md）
// ============================================================
// 只改并发上限、run 又在飞时，`AmendWorkflow` 不编译、不铸新 run，只把那条 run 的上限改掉。于是
// 这一行没有卡可画：那条 run 的卡在它启动的那一轮里，再画一张会读成第二次运行；而原来的静态卡
// 会摆出「已通过校验 · 调整 run X · 脚本不变」，三件事一件都没发生。
//
// 画的就是 GUI「配置」留下的那条设置行（`WorkflowSettingsChangeRow`），一字不差——同一件事由谁
// 发起不该有两种读法。唯一的差别是它**可点**：工具行是模型这一步的落点，用户从这里回到那条 run。

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import { WorkflowSettingsChangeRow } from "@/components/workflow-timeline/WorkflowSettingsChangeRow.js";

/**
 * 入参里那个数 → 设置轮那一块元数据。两者本来就是同一件事的两种记法（GUI 走轮元数据，工具走
 * 入参），映射到同一个形状之后措辞只剩一份实现。
 *
 * `requested` 是**模型发出的**数（readWorkflowRetuneCall）。它没有上限——默认并发 D 是起点不是
 * 天花板，高于 D 的数就是生效的数。所以这里把 D（元数据的 `ceiling` 键，名字早于「默认并发」）
 * 一起交给措辞规则：`workflowSettingsChangeSegments` 对 `to === D` 与 `to` 缺席一视同仁，都念
 * 「上限恢复为默认」（等于默认 = 这条 run 没有自己的界），其余的数照念。D 未知（那条 run 已被
 * 淘汰出投影、或老 CLI 没发过它）时只能照念请求值。
 *
 * `from` 不填：入参不知道改之前是多少，而这一行的措辞只读 `to`。`predecessorRunId` 同样不填——
 * 就地生效没有前驱（workflow-row-meta.ts）。
 */
function retuneAsAmendMeta(
  requested: number | null,
  defaultConcurrency: number | undefined,
): WorkflowSettingsAmendMeta {
  return {
    maxConcurrency: requested === null ? {} : { to: requested },
    ...(defaultConcurrency === undefined ? {} : { ceiling: defaultConcurrency }),
  };
}

export function WorkflowRetuneRow({
  defaultConcurrency,
  onOpen,
  requested,
  runId,
}: {
  /** 默认并发 D（那条 run 的投影读数 `run.concurrencyCeiling`）；未知时缺席。 */
  defaultConcurrency?: number;
  /** 打开这条 run 的详情页；宿主没给（只读面、灰度关）时这一行只是记录。 */
  onOpen?: () => void;
  requested: number | null;
  runId: string;
}) {
  const row = (
    <WorkflowSettingsChangeRow amend={retuneAsAmendMeta(requested, defaultConcurrency)} />
  );
  if (onOpen === undefined) {
    return (
      <div data-testid="workflow-retune-row" data-workflow-retune-run-id={runId}>
        {row}
      </div>
    );
  }
  return (
    <button
      className="flex w-full min-w-0 cursor-pointer rounded-md px-1 text-left transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40"
      data-testid="workflow-retune-row"
      data-workflow-retune-run-id={runId}
      onClick={onOpen}
      type="button"
    >
      {row}
    </button>
  );
}
