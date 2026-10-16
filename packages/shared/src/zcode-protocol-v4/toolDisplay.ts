// zcode-protocol-v4 toolCall 的展示层 schema。
// 从 rows.ts 拆出：两侧增量叠加后 rows.ts 触发 oxlint max-lines(400)。
// 本文件只含不依赖 rowBaseFields 的纯展示 union，rows.ts 单向依赖它，无循环。
import { z } from "zod";
import { bashOutputDisplaySchema } from "../bash-output-display.js";
import { timestampSchema } from "./core.js";
import { OFFICIAL_MCP_TOOL_ERROR_CODES } from "../official-mcp-tool-error.js";
import { cuaRequestAccessStatusSchema } from "./cuaPermission.js";
import { mcpToolDisplayUiSchema } from "../mcp-apps/schemas.js";
import { toolCallCreateWorkflowDisplaySchema } from "./create-workflow-display.js";
import {
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
} from "./workflow-observation-display.js";

// toolCall 终态 output 的结构化展示模型（port 自 feat；CUA 工具靠 kind:"cua" 分支把
// errorCode/suggestedAction/media(screenshot) 等结构化内容带到 renderer）。consume-main 之前
// 缺这个 union + toolOutputSchema.display 字段——协议层 zod 校验会把 agent 下发的 display 整个
// strip 掉，导致 UI 永远拿不到 display?.kind==="cua"，CUA 工具调用退化成 fallback 渲染。
const toolResultDisplaySchema = z.discriminatedUnion("kind", [
  bashOutputDisplaySchema,
  z.object({
    kind: z.literal("file_diff"),
    filePath: z.string().min(1),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    structuredPatch: z.array(
      z.object({
        oldStart: z.number().int(),
        oldLines: z.number().int(),
        newStart: z.number().int(),
        newLines: z.number().int(),
        lines: z.array(z.string()),
      }),
    ),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("local_agent_message"),
    status: z.enum(["success", "failed"]),
    error: z.string().optional(),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal("task_stop"),
    taskId: z.string().min(1),
    taskType: z.string().min(1),
    command: z.string().min(1).optional(),
    message: z.string().min(1),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  }),
  z.object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  }),
  z.object({
    kind: z.literal("cua"),
    schemaVersion: z.literal(1),
    toolName: z.string().min(1),
    status: z.enum(["success", "failed"]),
    // 旧 v1 snapshot 曾重复携带 ToolCallRow.input；只为历史回放继续接受。
    input: z.string().optional(),
    structuredContent: z.string().optional(),
    text: z.string().optional(),
    errorCode: z.string().optional(),
    suggestedAction: z.string().optional(),
    permissionStatus: cuaRequestAccessStatusSchema.optional(),
    targetApp: z
      .object({
        schemaVersion: z.literal(1),
        displayName: z.string().trim().min(1).max(512).optional(),
        iconLocators: z
          .array(
            z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("darwin-bundle-id"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-executable-path"),
                  value: z.string().trim().min(1).max(32_768),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("windows-aumid"),
                  value: z.string().trim().min(1).max(512),
                })
                .strict(),
            ]),
          )
          .max(3),
      })
      .strict()
      .optional(),
    media: z
      .array(
        z.object({
          mimeType: z.string().min(1),
          data: z.string().min(1).max(349_528).optional(),
          artifactUri: z.string().min(1).optional(),
        }),
      )
      .max(4)
      .optional(),
    truncated: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    // 与 toolCallMcpDisplaySchema 同源：不在这里声明，zod 会把 agent 下发的 unavailable
    // 静默 strip 掉，官方 MCP 额度提示在 v4 链路上失效（同本文件顶部 display strip 的坑）。
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    // 插件 UI 元数据；与 CLI contracts 的 mcpToolResultDisplayPayloadSchema 同源复用，见 mcp-apps/schemas.ts。
    ui: mcpToolDisplayUiSchema.optional(),
  }),
  // buildToolOutput 把 CLI 侧 ToolResultDisplayPayload 原样塞进 toolOutput.display，
  // 而这条 union 是 strict 的——create_workflow 不在成员里，CreateWorkflow 的 display 会被整段
  // 拒掉/剥掉，工具卡退化成纯文本。两侧成员表必须同步（同 contracts 的
  // toolResultDisplayPayloadSchema），所以直接复用 toolCall 侧同形的那份 schema。
  toolCallCreateWorkflowDisplaySchema,
  // 观察类工作流工具的五个 display kind + ResumeWorkflowRun 的恢复卡（同上：与 contracts
  // 侧同步，缺成员 = 整块被剥）。
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolResultDisplay = z.infer<typeof toolResultDisplaySchema>;

// §4.4.5 toolCall。终态 output 全档统一 head+tail 截断（R-10），超出走 truncated.ref 按需拉。
//
// ⚠ display 在信封层**不设门**（`.optional().catch(undefined)`）：解析不过就退化成「这张卡没有
// 载荷」，而不是让整条 row、整帧、整条订阅失败。四个嵌入点共用这条规则——本文件的
// toolOutputSchema、rows.ts 的 toolCallRow、snapshot.ts 的确认预览、workflow-row-meta.ts 的
// 启动行图；spec 见 docs/v4-refactor/10-protocol-spec.md §4.4.5 与
// docs/v4-refactor/04-sync-and-recovery.md 封闭规则 11。
//
// 根因（2026-09-21，sess_4142de31）：display 是装饰载荷，却长在 liveness 关键的信封里。CLI 给
// `list_workflow_runs` 的 run 行加了两个 lineage 键，本侧镜像没跟上 → 整帧被
// `proto.frameAssemblyInvalidPayload` 拒 → 恢复阶梯在同一份内容上重试 → 会话停在
// `fault.subscription.recoveryFailed`；而每次快照都重放同一份存量载荷，会话永不自愈。同款事故
// 2026-09-17 已经发生过一次（`get_workflow_run` 的 `providerStop`），当时只修了那一个字段。
//
// 严格性没有丢，只是回到该在的那一层：渲染侧 readToolResultDisplay
// （packages/ui/src/ToolCallBlocks/toolResultDisplay.ts）本来就按 kind 逐个 strict 解析，失败即
// 回 undefined、卡片退化成纯文本——这正是各 spec 一直承诺的行为。信封层那道门是重复的第二道
// 门，唯一的独有效果是杀死会话。
//
// 成员 schema 仍然 `.strict()`：它们定义「本端认得的形状」，catch 只把「不认得」从致命降级为
// 无卡。代价是 skew 变静默，补偿手段是构造侧与镜像侧的 parity 测试，而不是让线上订阅去发现。
export const toolOutputSchema = z.object({
  text: z.string(),
  display: toolResultDisplaySchema.optional().catch(undefined),
  truncated: z
    .object({
      totalBytes: z.number(),
      ref: z.string(),
    })
    .optional(),
});
export type ToolOutput = z.infer<typeof toolOutputSchema>;

// 工具运行中的进度（）：MCP `notifications/progress` 经 ToolCallProgress 事件投影到行上。
// fraction 由 payload progress/total 推得（total 缺失时不填）；bytes / previewLine 保留给 shell 输出型进度。
export const toolProgressSchema = z.object({
  bytes: z.number().optional(),
  previewLine: z.string().optional(),
  fraction: z.number().min(0).max(1).optional(),
  total: z.number().optional(),
  message: z.string().max(200).optional(),
  updatedAt: timestampSchema,
});
export type ToolProgress = z.infer<typeof toolProgressSchema>;

/**
 * node_repl cell 的目标应用身份（Computer Use 的工具卡图标）。与 CLI contracts 的
 * `nodeReplCuaAppDisplaySchema` 必须同集——两侧都是 strict，少一个字段会让整块 display 被剥掉。
 */
const toolCallNodeReplCuaAppDisplaySchema = z
  .object({
    appKey: z.string().trim().min(1).max(2_048),
    displayName: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

const toolCallNodeReplImageDisplaySchema = z
  .object({
    kind: z.literal("node_repl_images"),
    // images 可选：CUA 的纯动作 cell 没有截图，但仍要携带 app 身份。kind 名保留不动，
    // 改名会让已持久化的 row 在这条 strict union 里整段校验失败。
    images: z
      .array(
        z
          .object({
            base64: z
              .string()
              .min(1)
              .max(200 * 1024),
            mimeType: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .min(1)
      .max(2)
      .optional(),
    app: toolCallNodeReplCuaAppDisplaySchema.optional(),
    truncated: z.boolean().optional(),
    source: z.literal("browser_turn_end").optional(),
  })
  .strict();

const toolCallTaskOutputDisplaySchema = z
  .object({
    kind: z.literal("task_output"),
    retrievalStatus: z.enum(["success", "not_ready", "timeout"]),
    taskStatus: z.string().min(1).max(64).optional(),
    output: z.string().min(1).max(2_000).optional(),
    truncated: z.literal(true).optional(),
  })
  .strict();

const toolCallRespondToCoordinatorDisplaySchema = z
  .object({
    kind: z.literal("respond_to_coordinator"),
    status: z.enum(["success", "failed"]),
  })
  .strict();

const toolCallMcpDisplaySchema = z
  .object({
    kind: z.literal("mcp_tool"),
    serverName: z.string().min(1).max(256),
    toolName: z.string().min(1).max(256),
    description: z
      .string()
      .min(1)
      .max(4 * 1024)
      .optional(),
    /**
     * 官方 Server MCP 判定本次调用不可用（额度耗尽 / 无 Coding Plan）时下发的结构化标识。
     * CLI 侧只在官方来源 + isError 时填充，UI 据此在输入框上方提示。
     * 与 CLI contracts 的 mcpToolResultDisplayPayloadSchema 必须同步——两侧都是 strict，
     * 少加一处会让整条 row 校验失败。
     */
    unavailable: z
      .object({ code: z.enum(OFFICIAL_MCP_TOOL_ERROR_CODES) })
      .strict()
      .optional(),
    ui: mcpToolDisplayUiSchema.optional(),
  })
  .strict();

export const toolCallDisplaySchema = z.discriminatedUnion("kind", [
  toolCallNodeReplImageDisplaySchema,
  toolCallTaskOutputDisplaySchema,
  toolCallRespondToCoordinatorDisplaySchema,
  toolCallMcpDisplaySchema,
  toolCallCreateWorkflowDisplaySchema,
  toolCallGetWorkflowRunDisplaySchema,
  toolCallListWorkflowRunsDisplaySchema,
  toolCallEvalWorkflowSnippetDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
  toolCallListModelsDisplaySchema,
  toolCallResumeWorkflowRunDisplaySchema,
]);
export type ToolCallDisplay = z.infer<typeof toolCallDisplaySchema>;
