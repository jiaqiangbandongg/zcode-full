// ============================================================
// FillWorkflowHole Tool - 给一个正在等代码的留白补上函数体
// ============================================================
// docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」；引擎侧见
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Holes」，端口方法
// `DynamicWorkflowRunPort.fillHole`（interfaces/dynamic-workflow-run.port.ts）。
//
// 与 AmendWorkflow 分成两个工具的理由：补全**什么都不启动**——run 保持它的 id、journal 与子代理，
// 只是在留白处长出模型写下的那一段。输出与 CreateWorkflow / AmendWorkflow 共用一个形状，好让有效
// 脚本的 display 载荷照启动那样骑在工具行上，run 卡取它 run id 下最新的一份。

import { z } from "zod";
import { CreateWorkflowOutputJsonSchema, CreateWorkflowOutputSchema } from "./create-workflow.js";
import { toToolJsonSchema } from "./json-schema.js";

export const FILL_WORKFLOW_HOLE_TOOL_NAME = "FillWorkflowHole";

/**
 * 「恰好给一个函数体来源」的违规说明。与 `CREATE_WORKFLOW_SOURCE_ERROR` 同一个位置、同一种语气；
 * 与 AmendWorkflow 不同的是两个都不给在这里**也是**违规——没有可沿用的函数体。
 */
export const FILL_WORKFLOW_HOLE_SOURCE_ERROR =
  "Provide exactly one body source: `script` for the hole's statements written inline, or `path` for a file holding them (usually the fill file a rejected attempt was saved to). Passing both, or neither, is ambiguous.";

/**
 * 模型面入参。`hole` 不在这里——那是 resolveInput 回填的事实（下面），模型的 JSON schema 不列它。
 */
const FillWorkflowHoleModelInputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .describe("ID of the run that is waiting at the hole (from the hole notification)."),
  hole_id: z
    .string()
    .min(1)
    .describe(
      "The hole's site id from the notification or from GetWorkflowRun's holes, e.g. `hole#21b40fca`.",
    ),
  /**
   * 函数体**只有语句**：不含 `hole(...)` 调用、不含箭头、不含它周围的脚本。工具把它拼进 run 存档的
   * 脚本作为留白的函数体再整体编译（docs/dynamic-workflow/launch.md「Input and output」）。
   */
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The body: only the statements of the hole's function, inline. This OR `path`, never both. It is compiled where the hole stands and sees every binding declared before it; it must return the hole's type.",
    ),
  /**
   * 被拒绝的一次尝试的回程（「The fill file」）：内联提交被写到 fill 文件，诊断给的是那个文件的行号，
   * 下一次只改一行再把同一个路径交回来。
   */
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A file holding those statements — usually the fill file named by a rejected attempt, edited in place. This OR `script`, never both.",
    ),
});

/**
 * resolveInput 回填的留白事实（docs/dynamic-workflow/launch.md「Approval」）。
 *
 * 权限判定（本会话的 run 免确认）与确认窗（留白的名字与类型、草稿路径）都读它，而两处都在
 * handler 之前、且必须同步——所以由 resolveInput（异步、全流程唯一一次读端口）算好放进入参。
 * 归一化**无条件覆盖**：模型伪造它是无效的（AmendWorkflow 的 `predecessor` 同一条先例）。
 *
 * `owned_by_this_session` 已折进 amend 规则的第二个条件：run 归本会话**且**不是用户亲手停下的。
 * 一个被用户停下的 run 不可能仍在留白处等待，所以这一位在实践上只会因归属为假。
 */
export const FillWorkflowHoleHoleSchema = z
  .object({
    /** 留白的字面名（`hole<T>("决定分组", …)` 的 `"决定分组"`）。 */
    name: z.string().min(1),
    /** 留白的类型实参原文（`Verdict`、`string[]`），照脚本写法。 */
    type: z.string().min(1),
    /** run 的草稿文件（绝对路径）；run 没记过文件时缺席。 */
    draft_path: z.string().min(1).optional(),
    /** 留白调用在草稿里的行号（1 起）；读不到时缺席。 */
    line: z.number().int().positive().optional(),
    owned_by_this_session: z.boolean(),
  })
  .strict();

export type FillWorkflowHoleHole = z.infer<typeof FillWorkflowHoleHoleSchema>;

/**
 * 「这个 run 归本会话、且不是用户亲手停下的」——免确认的 owner 规则
 * （docs/dynamic-workflow/launch.md「Approval」，读的是「Amending this session's runs」那条）。
 *
 * 与 `isAmendWorkflowOwnedPredecessor` 同一条论证：住在契约里，权限服务与 handler 读同一份谓词。
 * 收 `unknown`：权限服务拿到的是还没解析的工具入参，handler 拿到的是解析好的事实块。
 */
export function isFillWorkflowHoleOwnedRun(hole: unknown): boolean {
  if (!hole || typeof hole !== "object") return false;
  return (hole as Record<string, unknown>).owned_by_this_session === true;
}

/**
 * 运行时入参：模型面那些键 + 回填的 `hole`。`.strict()`：任何旧拼写在这里都是可见错误。
 * 归一化后 `script`（函数体的字节）与 `path` 可以同时在场——`path` 提交读成 `script`、路径留作
 * 来龙去脉，与 AmendWorkflow 同一条「读一次、只读一次」纪律。
 */
export const FillWorkflowHoleInputSchema = FillWorkflowHoleModelInputSchema.extend({
  hole: FillWorkflowHoleHoleSchema.optional(),
}).strict();

export type FillWorkflowHoleInput = z.infer<typeof FillWorkflowHoleInputSchema>;

/** 交给模型的 JSON schema：不含 `hole`。 */
export const FillWorkflowHoleInputJsonSchema = toToolJsonSchema(
  FillWorkflowHoleModelInputSchema.strict(),
);

/**
 * 输出**就是** `CreateWorkflowOutput`（同一个 schema 对象，不是拷贝）：display 载荷因此在协议上
 * 与启动行同形，UI 的 CreateWorkflow 行渲染器按工具名选中本工具的行。补全不启动任何东西，所以
 * `status: "backgrounded"` 与 `backgroundTaskId` 在这里永远缺席。
 */
export const FillWorkflowHoleOutputSchema = CreateWorkflowOutputSchema;
export type FillWorkflowHoleOutput = z.infer<typeof FillWorkflowHoleOutputSchema>;
export const FillWorkflowHoleOutputJsonSchema = CreateWorkflowOutputJsonSchema;
